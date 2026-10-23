import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ActionError,
  ActionValidationError,
  type ActionResult,
  type Actor,
  type AnyActionDefinition,
  type HttpCall,
  type HttpContext,
  type HttpStep,
  type HttpSteps,
  type Logger,
  type RecordRef,
  type StepResponse,
} from '@wardenhq/actions';
import {
  MAX_ACTION_RECORDS,
  MAX_REASON_LENGTH,
  auditDiff,
  canRunAction,
  checkActionUrl,
  checkReason,
  decodeRecordId,
  encodeRecordId,
  isAllowed,
  oversizedInputArrays,
  previewTokenPayload,
  redactInput,
  runnableActions,
  stepsProgress,
  toFieldErrors,
  type ActionChange,
  type ActionPolicy,
  type AuditDiff,
  type EffectiveSchema,
  type FieldError,
  type Policy,
  type ResolvedAction,
  type AuditStore,
  type Entity,
  type StepsProgress,
} from '@wardenhq/core';
import {
  ActionWriteError,
  AuditUnavailableError,
  auditHook,
  createActionTx,
  getRow,
  getRows,
  insertActionEntry,
  isDataError,
  loadActionAttempt,
  lockKeyedRows,
  mapWriteError,
  setActorSettings,
  setStatementTimeout,
  storesField,
  toRecordRef,
  type ActionTxHandle,
  type Database,
  type DetachedTransaction,
  type Row,
} from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  contextActor,
  isSignInAgain,
  runHttpAction,
  runHttpSteps,
  type Credentials,
  type HttpAction,
  type HttpActions,
  type HttpRequestPlan,
  type StepRunner,
} from '../http-actions.js';
import { createSlots } from '../slots.js';
import type { Views } from '../views.js';
import { NO_NUL } from './schemas.js';

/** Changes a preview sends back; `total` still counts them all. */
export const MAX_PREVIEW_CHANGES = 200;
const MAX_RECORD_ID_LENGTH = 10_000;
const MAX_TOKEN_LENGTH = 200;
const RECORDS_REPEAT = 'records must not repeat';
/**
 * How long after a run its remaining steps may be retried. APIs commonly keep idempotency keys
 * for a day; past that, resending a step that may have applied could apply it twice.
 */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ActionLimits {
  /** Runs and previews at once on this server, across all users: the action pool's size. */
  maxConcurrent: number;
  /** Runs and previews one user may have going at once. */
  maxPerUser: number;
  /** How long a run or preview may take, unless the action sets its own `deadlineMs`. */
  deadlineMs: number;
}

export const DEFAULT_ACTION_LIMITS: ActionLimits = {
  maxConcurrent: 4,
  maxPerUser: 2,
  deadlineMs: 60_000,
};

export interface ActionRouteOptions {
  db: Database;
  /**
   * Begin a run's transaction, on a pool of its own so runs can't starve other requests. The
   * connection must not be shared, so a run past its deadline can be cut off.
   */
  startTransaction: () => Promise<DetachedTransaction>;
  limits?: Partial<ActionLimits>;
  schema: EffectiveSchema;
  policy: Policy;
  views: Views;
  actionPolicy: ActionPolicy;
  /** The loaded definitions, by name: `run` and `defaults` live here. */
  definitions: ReadonlyMap<string, AnyActionDefinition>;
  /** The first configured schema, which unqualified table keys refer to. */
  defaultSchema: string;
  /** Keys preview tokens. */
  sessionSecret: string;
  /** Where changes are audited; `warden.audit_log` when absent. */
  audit?: AuditStore | undefined;
  /** HTTP actions' credentials, checked at startup. */
  http?: HttpActions | undefined;
}

/** What `GET /api/actions` says about an action, so the UI can offer it and build its form. */
export interface ActionDescriptor {
  name: string;
  label: string;
  description?: string;
  /** Entity key. */
  on: string;
  target: ResolvedAction['target'];
  confirm: ResolvedAction['confirm'];
  destructive: boolean;
  requireReason: boolean;
  /** The shortest a required reason may be, once trimmed; present with `requireReason`. */
  reasonMinLength?: number;
  hasDefaults: boolean;
  inputSchema: ResolvedAction['inputSchema'];
  /** What the action can change: entity key → writes. */
  permissions: Record<string, string[]>;
}

interface ActionParams {
  name: string;
}
interface ActionBody {
  records?: string[];
  input?: Record<string, unknown>;
  reason?: string;
}
interface RunBody extends ActionBody {
  previewToken?: string;
}

const actionBodyProperties = {
  records: {
    type: 'array',
    maxItems: MAX_ACTION_RECORDS,
    items: { type: 'string', minLength: 1, maxLength: MAX_RECORD_ID_LENGTH },
  },
  // Checked against the action's own input schema.
  input: { type: 'object' },
  reason: { type: 'string', maxLength: MAX_REASON_LENGTH, pattern: NO_NUL },
} as const;
const previewBodySchema = { type: 'object', properties: actionBodyProperties } as const;
const runBodySchema = {
  type: 'object',
  properties: {
    ...actionBodyProperties,
    previewToken: { type: 'string', minLength: 1, maxLength: MAX_TOKEN_LENGTH },
  },
} as const;
const retryBodySchema = {
  type: 'object',
  required: ['auditId'],
  additionalProperties: false,
  properties: { auditId: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' } },
} as const;
const defaultsQuerySchema = {
  type: 'object',
  properties: { record: { type: 'string', minLength: 1, maxLength: MAX_RECORD_ID_LENGTH } },
} as const;

declare module 'fastify' {
  interface FastifyRequest {
    /** The action an /api/actions/:name route addresses, once the caller may run it. */
    action?: ResolvedAction;
  }
}

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });
const badRequest = (reply: FastifyReply, message: string, details: FieldError[] = []) =>
  reply.code(400).send({
    statusCode: 400,
    error: 'Bad Request',
    message,
    ...(details.length > 0 ? { details } : {}),
  });

const serverError = (reply: FastifyReply) =>
  reply.code(500).send({
    statusCode: 500,
    error: 'Internal Server Error',
    message: 'Internal Server Error',
  });

const conflict = (reply: FastifyReply, message: string) =>
  reply.code(409).send({ statusCode: 409, error: 'Conflict', message });

const tooMany = (reply: FastifyReply) =>
  reply.code(429).send({
    statusCode: 429,
    error: 'Too Many Requests',
    message: 'too many actions are running; try again when one finishes',
  });

/**
 * Postgres rolled the transaction back to break a deadlock or a serialization conflict with
 * another one; running again can succeed. Looks through wrapping errors (a failed `tx` write).
 */
function isRetryable(err: unknown): boolean {
  let e = err;
  for (let depth = 0; depth < 5 && typeof e === 'object' && e !== null; depth++) {
    const { code, cause } = e as { code?: unknown; cause?: unknown };
    if (code === '40P01' || code === '40001') return true;
    e = cause;
  }
  return false;
}

/** The run's deadline passed. */
class TookTooLong extends Error {}

/** Thrown inside the transaction to roll it back and answer with a response instead. */
class Answer {
  constructor(readonly send: (reply: FastifyReply) => FastifyReply) {}
}

/** What a run (or a preview of one) produced, inside its transaction. */
interface Outcome {
  auditId: string;
  result: ActionResult;
  changes: ActionChange[];
  token: string;
  afterCommit: (() => Promise<void>)[];
  /** For an HTTP action: the requests to make once the action's entry is committed. */
  plans?: HttpRequestPlan[];
  /** For a multi-step HTTP action: its steps, to run once the action's entry is committed. */
  steps?: StepRunner[];
  /** For a multi-step HTTP action: the target records' ids. */
  records?: string[];
  /** For an HTTP action on one record: its row, for the follow-up entry. */
  record?: Row | undefined;
}

/** Only the documented parts of what `run` returned, so nothing else reaches the client. */
function cleanResult(value: unknown): ActionResult {
  if (typeof value !== 'object' || value === null) return {};
  const { message, redirect } = value as Record<string, unknown>;
  const result: ActionResult = {};
  if (typeof message === 'string') result.message = message;
  if (typeof redirect === 'object' && redirect !== null) {
    const { entity, id } = redirect as Record<string, unknown>;
    if (typeof entity === 'string' && typeof id === 'string') result.redirect = { entity, id };
  }
  return result;
}

const pick = <T>(values: Record<string, T> | null, fields: ReadonlySet<string>) =>
  values && Object.fromEntries(Object.entries(values).filter(([f]) => fields.has(f)));

/**
 * Custom actions: list the ones the caller may run, prefill their forms, preview them (run and
 * roll back), and run them. Every route checks `canRunAction` first; an action the caller may
 * not run is a 404, exactly like one that doesn't exist.
 */
export function registerActionRoutes(app: FastifyInstance, options: ActionRouteOptions) {
  const { db, schema, policy, views, actionPolicy, definitions, defaultSchema } = options;
  const { startTransaction, audit: store = { kind: 'warden' }, http } = options;
  const { deadlineMs, ...caps } = { ...DEFAULT_ACTION_LIMITS, ...options.limits };
  const acquire = createSlots(caps);
  // An HTTP action's API calls hold no connection, so they don't take the pool's slots.
  const acquireApi = createSlots({
    maxConcurrent: Number.POSITIVE_INFINITY,
    maxPerUser: caps.maxPerUser,
  });
  const byTable = new Map(schema.entities.map((e) => [`${e.schema}.${e.name}`, e]));
  const entities = new Map(schema.entities.map((e) => [e.key, e]));
  // `tx` takes config-style table keys. Hidden tables aren't in the effective schema, and tables
  // config denies reading are just as absent: a table `deny` beats actions too.
  const resolveTable = (table: string) => {
    const entity = byTable.get(table.includes('.') ? table : `${defaultSchema}.${table}`);
    return entity && !policy.denied.get(entity.key)?.has('read') ? entity : undefined;
  };

  const sign = (payload: string) =>
    createHmac('sha256', options.sessionSecret)
      .update(`warden-action-preview\0${payload}`)
      .digest('base64url');
  const sameToken = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  const actorOf = (req: FastifyRequest): Actor => {
    const session = req.session!;
    return {
      subject: session.subject,
      ...(session.email ? { email: session.email } : {}),
      ...(session.name ? { name: session.name } : {}),
      ...(session.userId ? { userId: session.userId } : {}),
      roles: req.roles ?? [],
    };
  };

  const describe = (action: ResolvedAction): ActionDescriptor => ({
    name: action.name,
    label: action.label,
    ...(action.description !== undefined ? { description: action.description } : {}),
    on: action.on,
    target: action.target,
    confirm: action.confirm,
    destructive: action.destructive,
    requireReason: action.requireReason,
    ...(action.reasonMinLength !== undefined ? { reasonMinLength: action.reasonMinLength } : {}),
    hasDefaults: typeof definitions.get(action.name)?.defaults === 'function',
    inputSchema: action.inputSchema,
    permissions: action.permissions,
  });

  /**
   * A change as the caller may see it: only fields they can read, and nothing at all of
   * entities they can't read. Hidden fields were never recorded.
   */
  const visibleChange = (roles: readonly string[], change: ActionChange) => {
    const view = views(roles).entities.get(change.entity);
    const readable = view !== undefined && isAllowed(policy, roles, change.entity, 'read');
    if (!readable) {
      return {
        operation: change.operation,
        entity: change.entity,
        recordId: null,
        before: null,
        after: null,
        diff: {},
      };
    }
    const fields = new Set(view.fields.map((f) => f.name));
    return {
      operation: change.operation,
      entity: change.entity,
      recordId: change.recordId,
      before: pick(change.before, fields),
      after: pick(change.after, fields),
      diff: pick(change.diff, fields) as AuditDiff,
    };
  };

  // Before the body is validated, so callers who can't run an action learn nothing about it.
  const authorize = async (req: FastifyRequest<{ Params: ActionParams }>, reply: FastifyReply) => {
    const action = canRunAction(actionPolicy, policy, req.roles ?? [], req.params.name);
    if (!action) return notFound(reply);
    req.action = action;
  };

  app.get('/api/actions', async (req) => ({
    actions: runnableActions(actionPolicy, policy, req.roles ?? []).map(describe),
  }));

  app.get<{ Params: ActionParams; Querystring: { record?: string } }>(
    '/api/actions/:name/defaults',
    { preValidation: authorize, schema: { querystring: defaultsQuerySchema } },
    async (req, reply) => {
      const action = req.action!;
      const definition = definitions.get(action.name)!;
      const entity = entities.get(action.on)!;
      let record: RecordRef | undefined;
      if (req.query.record !== undefined) {
        if (action.target !== 'one') return badRequest(reply, 'this action takes no record');
        const decoded = decodeRecordId(entity, req.query.record);
        const row = decoded.ok ? await getRow(db, entity, decoded.filter) : undefined;
        if (!row) return notFound(reply);
        record = toRecordRef(entity, row);
      }
      let values: unknown;
      try {
        values = definition.defaults
          ? await definition.defaults({ actor: actorOf(req), ...(record ? { record } : {}) })
          : {};
        if (typeof values !== 'object' || values === null || Array.isArray(values)) {
          throw new Error(`defaults of action "${action.name}" must return an object`);
        }
      } catch (err) {
        return failed(req, reply, err);
      }
      return { values };
    },
  );

  /**
   * The requests an HTTP action makes: one, or one per record with `perRecord`. `url` and `body`
   * are the module's; only validated ids and input reach them.
   */
  const planRequests = (
    action: ResolvedAction,
    definition: AnyActionDefinition,
    input: Record<string, unknown>,
    resolved: Record<string, unknown>,
    refs: RecordRef[],
    actor: Actor,
    reason: string | undefined,
  ): HttpRequestPlan[] => {
    const call = definition.http as HttpCall<Record<string, unknown>>;
    const groups = action.http!.perRecord ? refs.map((r) => [r]) : [refs];
    return groups.map((group) => {
      const ctx: HttpContext<Record<string, unknown>> = {
        input: resolved,
        record: action.target === 'one' || action.http!.perRecord ? group[0] : undefined,
        records: action.target === 'many' ? group : undefined,
        actor,
        ...(reason ? { reason } : {}),
      } as HttpContext<Record<string, unknown>>;
      const records = group.map((r) => r.id);
      const url: unknown = typeof call.url === 'function' ? call.url(ctx) : call.url;
      if (typeof url !== 'string') {
        throw new Error(`action "${action.name}": http.url must return a string`);
      }
      const bad = checkActionUrl(url, http?.allowHttp ?? false);
      if (bad) throw new Error(`action "${action.name}": http.url ${bad}`);
      const value: unknown = call.body ? call.body(ctx) : { input, records };
      return { url, body: value === undefined ? '' : JSON.stringify(value), records };
    });
  };

  /**
   * A multi-step action's steps, ready to build their requests from earlier steps' answers. As
   * in `planRequests`, only validated ids and input reach the module's functions.
   */
  const stepRunners = (
    action: ResolvedAction,
    definition: AnyActionDefinition,
    input: Record<string, unknown>,
    resolved: Record<string, unknown>,
    refs: RecordRef[],
    actor: Actor,
    reason: string | undefined,
  ): StepRunner[] => {
    type Ctx = HttpContext<Record<string, unknown>>;
    type Prev = Record<string, StepResponse>;
    const call = definition.http as HttpSteps<Record<string, unknown>>;
    const ctx = {
      input: resolved,
      record: action.target === 'one' ? refs[0] : undefined,
      records: action.target === 'many' ? refs : undefined,
      actor,
      ...(reason ? { reason } : {}),
    } as Ctx;
    const records = refs.map((r) => r.id);
    const request = (
      what: string,
      url: HttpStep<Record<string, unknown>>['url'],
      body: ((ctx: Ctx, prev: Prev) => unknown) | undefined,
      prev: Prev,
    ): HttpRequestPlan => {
      const target: unknown = typeof url === 'function' ? url(ctx, prev) : url;
      if (typeof target !== 'string') {
        throw new Error(`action "${action.name}": ${what}.url must return a string`);
      }
      const bad = checkActionUrl(target, http?.allowHttp ?? false);
      if (bad) throw new Error(`action "${action.name}": ${what}.url ${bad}`);
      const value: unknown = body ? body(ctx, prev) : { input, records };
      return { url: target, body: value === undefined ? '' : JSON.stringify(value), records };
    };
    return action.http!.steps!.map((spec, i) => {
      const step = call.steps[i]!;
      return {
        spec,
        plan: (prev) => {
          if (step.when && !step.when(ctx, prev)) return null;
          return request(`http.steps[${i}]`, step.url, step.body, prev);
        },
        compensation: (prev) =>
          request(`http.steps[${i}].compensate`, step.compensate!.url, step.compensate!.body, prev),
      };
    });
  };

  /**
   * Build the steps' requests that need no earlier answer (up to the first step that will be
   * sent), so a module error there fails the run before its entry is written. The run then uses
   * them as built.
   */
  const prebuild = (runners: StepRunner[]): StepRunner[] => {
    let sending = false;
    return runners.map((runner) => {
      if (sending) return runner;
      const plan = runner.plan({});
      if (plan) sending = true;
      return { ...runner, plan: () => plan };
    });
  };

  /** Load the records ref input fields pick, with the action's (full) view of their entity. */
  const resolveRefs = async (
    trx: Database,
    action: ResolvedAction,
    input: Record<string, unknown>,
  ) => {
    // Bad ids and missing rows get the same message.
    const resolved: Record<string, unknown> = { ...input };
    const refErrors: FieldError[] = [];
    for (const ref of action.refs) {
      const value = input[ref.field];
      if (value === undefined || value === null) continue;
      const target = entities.get(ref.entity)!;
      const values = ref.many ? (value as unknown[]) : [value];
      const decoded = values.map((id) =>
        typeof id === 'string' ? decodeRecordId(target, id) : undefined,
      );
      const filters = decoded.flatMap((d) => (d?.ok ? [d.filter] : []));
      const found = await getRows(trx, target, filters);
      const loaded: RecordRef[] = [];
      const seen = new Set<string>();
      let next = 0;
      for (const [i, d] of decoded.entries()) {
        const row = d?.ok ? found[next++] : undefined;
        const loadedRef = row && toRecordRef(target, row);
        if (!loadedRef) {
          refErrors.push({
            field: ref.field,
            message: `${ref.many ? `item ${i}: ` : ''}references a record that does not exist`,
          });
        } else if (seen.has(loadedRef.id)) {
          // By canonical id, so "1" and "01" are the same record.
          refErrors.push({ field: ref.field, message: `item ${i}: repeats an earlier record` });
        } else {
          seen.add(loadedRef.id);
          loaded.push(loadedRef);
        }
      }
      resolved[ref.field] = ref.many ? loaded : loaded[0];
    }
    return { resolved, refErrors };
  };

  /** Attempts whose steps are being called now, so a retry can't overlap them. */
  const inFlight = new Set<string>();
  const flightKey = (action: string, auditId: string) => `${action}:${auditId}`;

  /**
   * Whether a failed run's remaining steps can be retried: the retry rebuilds the requests from
   * the attempt's entry, so that needs the whole input and a store that keeps details.
   */
  const canRetry = (action: ResolvedAction) =>
    action.sensitive.length === 0 &&
    storesField(store, 'details') &&
    storesField(store, 'actorSubject');

  /**
   * Call a multi-step action's steps (those not done in an earlier try), record how they went in
   * an entry of their own, and answer. Releases the user's API slot.
   */
  const callSteps = async (
    req: FastifyRequest,
    reply: FastifyReply,
    run: {
      action: ResolvedAction;
      httpAction: HttpAction;
      credentials: Credentials;
      actor: Actor;
      reason: string | undefined;
      entity: Entity;
      record: Row | undefined;
      records: string[];
      steps: StepRunner[];
      auditId: string;
      done: StepsProgress['done'];
      /** The retry's own entry. */
      retry?: string;
    },
    releaseApi: () => void,
  ) => {
    const { action, actor, reason, entity, auditId } = run;
    const key = flightKey(action.name, auditId);
    inFlight.add(key);
    try {
      const called = await runHttpSteps({
        req,
        action: run.httpAction,
        credentials: run.credentials,
        steps: run.steps,
        auditId,
        deadlineMs: action.deadlineMs ?? deadlineMs,
        done: run.done,
        retryable: canRetry(action),
        context: {
          action: action.name,
          auditId,
          requestId: req.id,
          actor: contextActor(actor),
          ...(reason ? { reason } : {}),
        },
        log: req.log,
      });
      // The log is append-only: which steps completed goes in an entry of its own.
      await insertActionEntry(db, {
        actor,
        store,
        requestId: req.id,
        action: action.name,
        entity,
        ...(action.target === 'one' && run.record ? { record: run.record } : {}),
        details: {
          input: {},
          records: run.records,
          refs: {},
          outcome: {
            attempt: auditId,
            ...(run.retry ? { retry: run.retry } : {}),
            ...called.outcome,
          },
        },
      }).catch((err: unknown) =>
        req.log.error({ err, action: action.name, auditId }, 'could not audit the API outcome'),
      );
      req.log.info(
        { action: action.name, auditId, result: called.outcome.result, retry: run.retry },
        'action run',
      );
      return reply.code(called.statusCode).send(called.body);
    } finally {
      inFlight.delete(key);
      releaseApi();
    }
  };

  /**
   * An HTTP action's credentials, got before anything is written: no credentials, no attempt.
   * Answers (and releases the API slot) when they can't be had.
   */
  const credentialsFor = async (
    req: FastifyRequest,
    reply: FastifyReply,
    action: ResolvedAction,
    releaseApi: () => void,
  ): Promise<{ httpAction: HttpAction; credentials: Credentials } | undefined> => {
    const httpAction = http?.actions.get(action.name);
    try {
      // Startup refuses HTTP actions it couldn't prepare.
      if (!httpAction) throw new Error(`action "${action.name}" has no prepared credentials`);
      return { httpAction, credentials: await httpAction.authenticator.credentials(req) };
    } catch (err) {
      releaseApi();
      if (isSignInAgain(err)) {
        void reply
          .code(401)
          .send({ statusCode: 401, error: 'Unauthorized', message: 'Sign in again to continue' });
        return undefined;
      }
      req.log.error({ err, action: action.name }, 'could not get credentials for the action API');
      void reply.code(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'the API this action calls failed; try again later',
      });
      return undefined;
    }
  };

  /**
   * Validate the request, then run the action in one transaction: lock the target records,
   * insert the parent audit entry, call `run` (each write audits its row under the parent), and
   * commit, or roll back for a preview, a stale preview token, or any error.
   */
  const execute = async (
    req: FastifyRequest<{ Params: ActionParams; Body: RunBody }>,
    reply: FastifyReply,
    mode: 'preview' | 'run',
  ) => {
    const action = req.action!;
    const definition = definitions.get(action.name)!;
    const entity = entities.get(action.on)!;
    const body = req.body ?? {};
    if (action.http && mode === 'preview') {
      return badRequest(reply, "this action calls an API, so it can't be previewed");
    }
    if (action.http && body.previewToken !== undefined) {
      return badRequest(reply, 'this action has no preview');
    }
    const ids = body.records ?? [];
    const rawInput = body.input ?? {};
    const checked = checkReason(
      body.reason,
      action.requireReason ? (action.reasonMinLength ?? 1) : undefined,
    );
    const reason = checked.ok ? checked.reason : undefined;

    const expected =
      action.target === 'one'
        ? ids.length === 1
        : action.target === 'many'
          ? ids.length >= 1
          : ids.length === 0;
    if (!expected) {
      return badRequest(
        reply,
        action.target === 'one'
          ? 'records must hold exactly one record id'
          : action.target === 'many'
            ? `records must hold 1 to ${MAX_ACTION_RECORDS} record ids`
            : 'this action takes no records',
      );
    }
    if (new Set(ids).size !== ids.length) return badRequest(reply, RECORDS_REPEAT);
    if (!checked.ok) return badRequest(reply, checked.message);

    // Unknown keys are rejected rather than stripped, as for record writes.
    const unknown = Object.keys(rawInput).filter(
      (key) => !Object.hasOwn(action.inputSchema.properties, key),
    );
    if (unknown.length > 0) {
      return badRequest(
        reply,
        'invalid input',
        unknown.map((key) => ({ field: key, message: `unknown field "${key}"` })),
      );
    }
    const oversized = oversizedInputArrays(action.inputSchema, rawInput);
    if (oversized.length > 0) return badRequest(reply, 'invalid input', oversized);
    let input: Record<string, unknown> = {};
    if (definition.input) {
      const parsed = await definition.input.safeParseAsync(rawInput);
      if (!parsed.success) return badRequest(reply, 'invalid input', toFieldErrors(parsed.error));
      input = parsed.data as Record<string, unknown>;
    }

    // A malformed id is a missing record, as on the entity routes.
    const targets = ids.flatMap((id) => {
      const decoded = decodeRecordId(entity, id);
      return decoded.ok ? [decoded.filter] : [];
    });
    if (targets.length !== ids.length) return notFound(reply);

    const actor = actorOf(req);
    const roles = req.roles ?? [];
    const requestId = req.id;
    const log = req.log.child({ action: action.name }) as unknown as Logger;

    let txHandle: ActionTxHandle | undefined;
    /** Everything the run does in its transaction; the caller commits or rolls back. */
    const work = async (trx: Database): Promise<Outcome> => {
      await setActorSettings(trx, actor);
      if (action.timeoutMs !== undefined) await setStatementTimeout(trx, action.timeoutMs);
      // Several ids can name one row ("1" and "01", a UUID in either case), so the targets are
      // looked up first and compared by their canonical ids. Then they're locked in one query in
      // primary-key order, so runs on overlapping records wait for each other, not deadlock.
      const found = await getRows(trx, entity, targets);
      if (found.some((row) => !row)) throw new Answer(notFound);
      const records = found.map((row) => encodeRecordId(entity, row!)!);
      if (new Set(records).size !== records.length) {
        throw new Answer((r) => badRequest(r, RECORDS_REPEAT));
      }
      const locked = await lockKeyedRows(
        trx,
        entity,
        records.flatMap((id) => {
          const decoded = decodeRecordId(entity, id);
          return decoded.ok ? [decoded.filter] : [];
        }),
      );
      const byId = new Map(locked.map((row) => [encodeRecordId(entity, row), row]));
      const rows: Row[] = [];
      for (const id of records) {
        // Gone, or its key changed, since it was looked up.
        const row = byId.get(id);
        if (!row) throw new Answer(notFound);
        rows.push(row);
      }

      // Picked records are loaded with the action's (full) view of their entity.
      const { resolved, refErrors } = await resolveRefs(trx, action, input);
      if (refErrors.length > 0) throw new Answer((r) => badRequest(r, 'invalid input', refErrors));
      const refs = rows.map((row) => toRecordRef(entity, row));
      // Built before the entry, so a module bug (or an ActionError) leaves no attempt behind.
      const steps = action.http?.steps
        ? prebuild(stepRunners(action, definition, input, resolved, refs, actor, reason))
        : undefined;
      const plans =
        action.http && !steps
          ? planRequests(action, definition, input, resolved, refs, actor, reason)
          : [];

      const auditId = await insertActionEntry(trx, {
        actor,
        store,
        requestId,
        ...(reason ? { reason } : {}),
        action: action.name,
        entity,
        ...(action.target === 'one' ? { record: rows[0]! } : {}),
        details: {
          input: redactInput(input, action.sensitive),
          records,
          refs: Object.fromEntries(action.refs.map((r) => [r.field, r.entity])),
        },
      });
      if (action.http) {
        return {
          auditId,
          result: {},
          changes: [],
          token: '',
          afterCommit: [],
          ...(steps ? { steps, records } : { plans }),
          record: rows[0],
        };
      }
      const audit = auditHook({
        actor,
        store,
        requestId,
        parentId: auditId,
        ...(reason ? { reason } : {}),
      });
      const changes: ActionChange[] = [];
      const handle = createActionTx(trx, {
        action: action.name,
        resolve: resolveTable,
        permissions: action.permissions,
        maxAffectedRows: action.maxAffectedRows,
        onWrite: async (t, change) => {
          await audit(t, change);
          const row = (change.after ?? change.before)!;
          changes.push({
            operation: change.action,
            entity: change.entity.key,
            recordId: toRecordRef(change.entity, row).id || null,
            before: change.before,
            after: change.after,
            diff: auditDiff(change.before, change.after),
            ...(change.action === 'create' && change.written
              ? { values: Object.fromEntries(change.written.map((f) => [f, row[f] ?? null])) }
              : {}),
          });
        },
      });
      txHandle = handle;
      const afterCommit: (() => Promise<void>)[] = [];
      let returned: unknown;
      let thrown: { error: unknown } | undefined;
      try {
        returned = await definition.run!({
          input: resolved,
          record: action.target === 'one' ? refs[0] : undefined,
          records: action.target === 'many' ? refs : undefined,
          tx: handle.tx,
          actor,
          ...(reason ? { reason } : {}),
          afterCommit: (fn: () => Promise<void>) => {
            afterCommit.push(fn);
          },
          log,
        });
      } catch (err) {
        thrown = { error: err };
      }
      // Calls `run` didn't await must not overlap the commit or rollback.
      const unfinished = await handle.close();
      if (thrown) throw thrown.error;
      // A database error aborted the transaction, so Postgres would answer COMMIT with a
      // silent ROLLBACK. Fail with it even if `run` caught it and returned.
      if (handle.failure) throw handle.failure.error;
      if (unfinished > 0) {
        throw new Error(
          `action "${action.name}" returned with ${unfinished} tx calls still running; await every tx call`,
        );
      }
      const result = cleanResult(returned);
      const token = sign(
        previewTokenPayload({ name: action.name, input: rawInput, records, changes }),
      );
      const outcome = { auditId, result, changes, token, afterCommit };
      if (mode === 'preview') throw new Answer((r) => r.send(previewResponse(roles, outcome)));
      if (body.previewToken !== undefined && !sameToken(token, body.previewToken)) {
        throw new Answer((r) =>
          r.code(409).send({
            statusCode: 409,
            error: 'preview_stale',
            message: 'what this action would change has changed since it was previewed',
          }),
        );
      }
      return outcome;
    };

    const releaseApi = action.http ? acquireApi(actor.subject) : () => {};
    if (!releaseApi) return tooMany(reply);
    let httpAction: HttpAction | undefined;
    let credentials: Credentials = {};
    if (action.http) {
      const got = await credentialsFor(req, reply, action, releaseApi);
      if (!got) return reply;
      ({ httpAction, credentials } = got);
    }
    const release = acquire(actor.subject);
    if (!release) {
      releaseApi();
      return tooMany(reply);
    }
    let outcome: Outcome;
    let transaction: DetachedTransaction | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      transaction = await startTransaction();
      // A run that never settles (a webhook without a timeout) can't hold its connection: past the
      // deadline the connection is closed, which rolls back, and `tx` refuses further calls.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TookTooLong()), action.deadlineMs ?? deadlineMs);
      });
      outcome = await Promise.race([work(transaction.trx), deadline]);
      clearTimeout(timer);
      await transaction.commit();
    } catch (err) {
      clearTimeout(timer);
      releaseApi();
      if (err instanceof TookTooLong) {
        void txHandle?.close();
        transaction?.destroy();
        req.log.warn({ action: action.name }, 'action took too long and was rolled back');
        return reply.code(503).send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'the action took too long and was rolled back',
        });
      }
      await transaction?.rollback().catch(() => {});
      return failed(req, reply, err);
    } finally {
      release();
    }

    if (outcome.steps) {
      return callSteps(
        req,
        reply,
        {
          action,
          httpAction: httpAction!,
          credentials,
          actor,
          reason,
          entity,
          record: outcome.record,
          records: outcome.records ?? [],
          steps: outcome.steps,
          auditId: outcome.auditId,
          done: new Map(),
        },
        releaseApi,
      );
    }
    if (outcome.plans) {
      try {
        const called = await runHttpAction({
          req,
          action: httpAction!,
          method: action.http!.method,
          plans: outcome.plans,
          credentials,
          auditId: outcome.auditId,
          deadlineMs: action.deadlineMs ?? deadlineMs,
          context: {
            action: action.name,
            auditId: outcome.auditId,
            requestId,
            actor: contextActor(actor),
            ...(reason ? { reason } : {}),
          },
          log: req.log,
        });
        // The log is append-only, so the API's answer goes in an entry of its own.
        await insertActionEntry(db, {
          actor,
          store,
          requestId,
          action: action.name,
          entity,
          ...(action.target === 'one' ? { record: outcome.record! } : {}),
          details: {
            input: {},
            records: outcome.plans.flatMap((p) => p.records),
            refs: {},
            outcome: { attempt: outcome.auditId, ...called.outcome },
          },
        }).catch((err: unknown) =>
          req.log.error(
            { err, action: action.name, auditId: outcome.auditId },
            'could not audit the API outcome',
          ),
        );
        req.log.info(
          { action: action.name, auditId: outcome.auditId, result: called.outcome.result },
          'action run',
        );
        return reply.code(called.statusCode).send(called.body);
      } finally {
        releaseApi();
      }
    }

    for (const fn of outcome.afterCommit) {
      try {
        await fn();
      } catch (err) {
        req.log.error({ err, action: action.name }, 'afterCommit callback failed');
      }
    }
    req.log.info(
      { action: action.name, auditId: outcome.auditId, changes: outcome.changes.length },
      'action run',
    );
    return { auditId: outcome.auditId, result: outcome.result };
  };

  const previewResponse = (roles: readonly string[], outcome: Outcome) => ({
    changes: outcome.changes.slice(0, MAX_PREVIEW_CHANGES).map((c) => visibleChange(roles, c)),
    total: outcome.changes.length,
    truncated: outcome.changes.length > MAX_PREVIEW_CHANGES,
    result: outcome.result,
    previewToken: outcome.token,
  });

  /**
   * An invalid `tx` call's problems as the caller may see them. Only fields they can read are
   * named, and problems that don't say which field they're about (a filter's) only go to
   * callers who can read every field. An entity they can't read isn't named at all.
   */
  const invalidCall = (
    reply: FastifyReply,
    roles: readonly string[],
    err: ActionValidationError,
  ) => {
    const details = (errors: FieldError[]) =>
      errors.map((e) => ({ message: e.field ? `${e.field}: ${e.message}` : e.message }));
    if (err.entity === undefined) return badRequest(reply, err.message, details(err.errors));
    const view = views(roles).entities.get(err.entity);
    if (!view || !isAllowed(policy, roles, err.entity, 'read')) {
      return badRequest(reply, 'the action made an invalid change');
    }
    const fields = entities.get(err.entity)?.fields ?? [];
    const readable = new Set(view.fields.map((f) => f.name));
    const unreadable = new Set(fields.filter((f) => !readable.has(f.name)).map((f) => f.name));
    // An unknown field (hidden ones included) isn't the entity's, so it's named for everyone.
    const shown = err.errors.filter((e) =>
      e.field !== undefined ? !unreadable.has(e.field) : unreadable.size === 0,
    );
    return badRequest(reply, err.message, details(shown));
  };

  /**
   * The author's own errors and invalid `tx` calls are 400s; constraint violations are mapped
   * like CRUD writes. Anything else, including writes outside `permissions` and exceeding
   * `maxAffectedRows` (bugs in the action), is a generic 500: action code can throw errors with
   * a 4xx `statusCode` (an SDK's), whose messages weren't written for users.
   */
  const failed = async (req: FastifyRequest, reply: FastifyReply, err: unknown) => {
    if (err instanceof Answer) return err.send(reply);
    if (isRetryable(err)) {
      req.log.warn({ err, action: req.action?.name }, 'action conflicted with another transaction');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'the action conflicted with another change and was rolled back; try again',
      });
    }
    if (err instanceof ActionError) {
      return badRequest(
        reply,
        err.message,
        err.field !== undefined ? [{ field: err.field, message: err.message }] : [],
      );
    }
    if (err instanceof ActionValidationError) {
      req.log.info({ err }, 'action made an invalid write');
      // The fields belong to whatever entity `run` wrote, not to the action's form.
      return invalidCall(reply, req.roles ?? [], err);
    }
    if (err instanceof ActionWriteError) {
      const roles = req.roles ?? [];
      const view = views(roles).entities.get(err.entity.key);
      // Only fields the caller can read are named.
      const named =
        view && isAllowed(policy, roles, err.entity.key, 'read')
          ? view
          : { ...err.entity, fields: [] };
      const mapped = await mapWriteError(db, named, err.cause, err.operation);
      if (mapped) {
        return reply.code(mapped.status).send({
          statusCode: mapped.status,
          error: mapped.status === 409 ? 'Conflict' : 'Bad Request',
          message:
            mapped.status === 409
              ? 'conflicts with existing records'
              : `invalid ${err.entity.key} record`,
          details: mapped.errors.map((e) => ({
            message: e.field ? `${e.field}: ${e.message}` : e.message,
          })),
        });
      }
      throw err.cause;
    }
    // Warden's own reads can still hit a value Postgres rejects; the app maps those to a 400.
    // The app also explains a misconfigured audit store.
    if (isDataError(err) || err instanceof AuditUnavailableError) throw err;
    req.log.error({ err, action: req.action?.name }, 'action failed');
    return serverError(reply);
  };

  /**
   * "Retry remaining steps": resend a failed multi-step run's failed step and the ones after it,
   * with the same idempotency keys, never the steps that completed. The request is rebuilt from
   * the attempt's audit entry, so only its input, records and reason are used, and only the user
   * who ran it may retry it; anyone else's attempt is a 404, like a missing one.
   */
  const retry = async (
    req: FastifyRequest<{ Params: ActionParams; Body: { auditId: string } }>,
    reply: FastifyReply,
  ) => {
    const action = req.action!;
    const definition = definitions.get(action.name)!;
    const entity = entities.get(action.on)!;
    const steps = action.http?.steps;
    if (!steps) return badRequest(reply, 'this action has no steps to retry');
    const actor = actorOf(req);
    const attempt = await loadActionAttempt(
      db,
      { id: req.body.auditId, action: action.name },
      store,
    );
    if (!attempt || attempt.actorSubject !== actor.subject || !attempt.details) {
      return notFound(reply);
    }
    if (!canRetry(action)) {
      return conflict(reply, "this action's input isn't kept in full, so run it again instead");
    }
    if (attempt.ageMs > RETRY_WINDOW_MS) {
      return conflict(reply, 'this run is too old to retry; run the action again');
    }
    if (inFlight.has(flightKey(action.name, attempt.id))) {
      return conflict(reply, 'this run is still calling the API; wait for it to finish');
    }
    const progress = stepsProgress(steps, attempt.outcomes);
    if (progress.compensated) {
      return conflict(
        reply,
        'the steps that completed were undone, so the rest would run without them; run the action again',
      );
    }
    if (progress.finished) return conflict(reply, 'every step of this run already completed');

    // The definition may have changed since: input that no longer fits it isn't sent.
    const changed = () =>
      conflict(reply, 'the action or its records changed since this run; run it again');
    const stored = attempt.details.input;
    if (Object.keys(stored).some((key) => !Object.hasOwn(action.inputSchema.properties, key))) {
      return changed();
    }
    let input: Record<string, unknown> = {};
    if (definition.input) {
      const parsed = await definition.input.safeParseAsync(stored);
      if (!parsed.success) return changed();
      input = parsed.data as Record<string, unknown>;
    }
    const ids = attempt.details.records;
    const targets = ids.flatMap((id) => {
      const decoded = decodeRecordId(entity, id);
      return decoded.ok ? [decoded.filter] : [];
    });
    if (targets.length !== ids.length) return changed();
    const rows = await getRows(db, entity, targets);
    if (rows.some((row) => !row)) return notFound(reply);
    const { resolved, refErrors } = await resolveRefs(db, action, input);
    if (refErrors.length > 0) return changed();
    const refs = rows.map((row) => toRecordRef(entity, row!));
    const reason = attempt.reason ?? undefined;

    const releaseApi = acquireApi(actor.subject);
    if (!releaseApi) return tooMany(reply);
    const got = await credentialsFor(req, reply, action, releaseApi);
    if (!got) return reply;
    let runners: StepRunner[];
    let retryId: string;
    try {
      runners = stepRunners(action, definition, input, resolved, refs, actor, reason);
      retryId = await insertActionEntry(db, {
        actor,
        store,
        requestId: req.id,
        ...(reason ? { reason } : {}),
        action: action.name,
        entity,
        ...(action.target === 'one' ? { record: rows[0]! } : {}),
        details: { input: {}, records: ids, refs: {}, retryOf: attempt.id },
      });
    } catch (err) {
      releaseApi();
      return failed(req, reply, err);
    }
    return callSteps(
      req,
      reply,
      {
        action,
        ...got,
        actor,
        reason,
        entity,
        record: rows[0] ?? undefined,
        records: ids,
        steps: runners,
        auditId: attempt.id,
        done: progress.done,
        retry: retryId,
      },
      releaseApi,
    );
  };

  app.post<{ Params: ActionParams; Body: { auditId: string } }>(
    '/api/actions/:name/retry',
    { preValidation: authorize, schema: { body: retryBodySchema } },
    (req, reply) => retry(req, reply),
  );

  app.post<{ Params: ActionParams; Body: ActionBody }>(
    '/api/actions/:name/preview',
    { preValidation: authorize, schema: { body: previewBodySchema } },
    (req, reply) => execute(req, reply, 'preview'),
  );

  app.post<{ Params: ActionParams; Body: RunBody }>(
    '/api/actions/:name/run',
    { preValidation: authorize, schema: { body: runBodySchema } },
    (req, reply) => execute(req, reply, 'run'),
  );
}
