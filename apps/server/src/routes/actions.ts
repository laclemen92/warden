import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ActionError,
  ActionValidationError,
  type ActionResult,
  type Actor,
  type AnyActionDefinition,
  type Logger,
  type RecordRef,
} from '@wardenhq/actions';
import {
  MAX_ACTION_RECORDS,
  auditDiff,
  canRunAction,
  decodeRecordId,
  isAllowed,
  previewTokenPayload,
  redactInput,
  runnableActions,
  toFieldErrors,
  type ActionChange,
  type ActionPolicy,
  type AuditDiff,
  type EffectiveSchema,
  type FieldError,
  type Policy,
  type ResolvedAction,
} from '@wardenhq/core';
import {
  ActionWriteError,
  auditHook,
  createActionTx,
  getRow,
  insertActionEntry,
  lockRow,
  mapWriteError,
  setStatementTimeout,
  toRecordRef,
  type Database,
  type Row,
} from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Views } from '../views.js';
import { MAX_REASON_LENGTH, REASON_REQUIRED } from './entities.js';

/** Changes a preview sends back; `total` still counts them all. */
export const MAX_PREVIEW_CHANGES = 200;
const MAX_RECORD_ID_LENGTH = 10_000;
const MAX_TOKEN_LENGTH = 200;

export interface ActionRouteOptions {
  db: Database;
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
  reason: { type: 'string', maxLength: MAX_REASON_LENGTH },
} as const;
const previewBodySchema = { type: 'object', properties: actionBodyProperties } as const;
const runBodySchema = {
  type: 'object',
  properties: {
    ...actionBodyProperties,
    previewToken: { type: 'string', minLength: 1, maxLength: MAX_TOKEN_LENGTH },
  },
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
  const byTable = new Map(schema.entities.map((e) => [`${e.schema}.${e.name}`, e]));
  const entities = new Map(schema.entities.map((e) => [e.key, e]));
  // `tx` takes config-style table keys. Hidden tables aren't in the effective schema.
  const resolveTable = (table: string) =>
    byTable.get(table.includes('.') ? table : `${defaultSchema}.${table}`);

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
      const values = definition.defaults
        ? await definition.defaults({ actor: actorOf(req), ...(record ? { record } : {}) })
        : {};
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        throw new Error(`defaults of action "${action.name}" must return an object`);
      }
      return { values };
    },
  );

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
    const ids = body.records ?? [];
    const rawInput = body.input ?? {};
    const reason = body.reason?.trim() || undefined;

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
    if (new Set(ids).size !== ids.length) return badRequest(reply, 'records must not repeat');
    if (action.requireReason && !reason) return badRequest(reply, REASON_REQUIRED);

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
    let input: Record<string, unknown> = {};
    if (definition.input) {
      const parsed = await definition.input.safeParseAsync(rawInput);
      if (!parsed.success) return badRequest(reply, 'invalid input', toFieldErrors(parsed.error));
      input = parsed.data as Record<string, unknown>;
    }

    // A malformed id is a missing record, as on the entity routes.
    const targets = ids.map((id) => decodeRecordId(entity, id));
    if (targets.some((t) => !t.ok)) return notFound(reply);

    const actor = actorOf(req);
    const roles = req.roles ?? [];
    const requestId = req.id;
    const log = req.log.child({ action: action.name }) as unknown as Logger;

    let outcome: Outcome;
    try {
      outcome = await db.transaction().execute(async (trx): Promise<Outcome> => {
        if (action.timeoutMs !== undefined) await setStatementTimeout(trx, action.timeoutMs);
        const rows: Row[] = [];
        for (const target of targets) {
          const row = target.ok ? await lockRow(trx, entity, target.filter) : undefined;
          if (!row) throw new Answer(notFound);
          rows.push(row);
        }

        // Picked records are loaded with the action's (full) view of their entity. Bad ids and
        // missing rows get the same message.
        const resolved: Record<string, unknown> = { ...input };
        const refErrors: FieldError[] = [];
        for (const ref of action.refs) {
          const value = input[ref.field];
          if (value === undefined || value === null) continue;
          const target = entities.get(ref.entity)!;
          const values = ref.many ? (value as unknown[]) : [value];
          const loaded: RecordRef[] = [];
          for (const [i, id] of values.entries()) {
            const decoded = typeof id === 'string' ? decodeRecordId(target, id) : undefined;
            const row = decoded?.ok ? await getRow(trx, target, decoded.filter) : undefined;
            if (!row) {
              refErrors.push({
                field: ref.field,
                message: `${ref.many ? `item ${i}: ` : ''}references a record that does not exist`,
              });
            } else {
              loaded.push(toRecordRef(target, row));
            }
          }
          resolved[ref.field] = ref.many ? loaded : loaded[0];
        }
        if (refErrors.length > 0)
          throw new Answer((r) => badRequest(r, 'invalid input', refErrors));

        const auditId = await insertActionEntry(trx, {
          actor,
          requestId,
          ...(reason ? { reason } : {}),
          action: action.name,
          entity,
          ...(action.target === 'one' ? { record: rows[0]! } : {}),
          details: {
            input: redactInput(input, action.sensitive),
            records: ids,
            refs: Object.fromEntries(action.refs.map((r) => [r.field, r.entity])),
          },
        });
        const audit = auditHook({
          actor,
          requestId,
          parentId: auditId,
          ...(reason ? { reason } : {}),
        });
        const changes: ActionChange[] = [];
        const tx = createActionTx(trx, {
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
        const refs = rows.map((row) => toRecordRef(entity, row));
        const afterCommit: (() => Promise<void>)[] = [];
        const result = cleanResult(
          await definition.run({
            input: resolved,
            record: action.target === 'one' ? refs[0] : undefined,
            records: action.target === 'many' ? refs : undefined,
            tx,
            actor,
            ...(reason ? { reason } : {}),
            afterCommit: (fn: () => Promise<void>) => {
              afterCommit.push(fn);
            },
            log,
          }),
        );
        const token = sign(
          previewTokenPayload({ name: action.name, input: rawInput, records: ids, changes }),
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
      });
    } catch (err) {
      return failed(req, reply, err);
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
   * The author's own errors and invalid `tx` calls are 400s; constraint violations are mapped
   * like CRUD writes. Anything else, including writes outside `permissions` and exceeding
   * `maxAffectedRows` (bugs in the action), is a generic 500.
   */
  const failed = async (req: FastifyRequest, reply: FastifyReply, err: unknown) => {
    if (err instanceof Answer) return err.send(reply);
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
      return badRequest(
        reply,
        err.message,
        err.errors.map((e) => ({ message: e.field ? `${e.field}: ${e.message}` : e.message })),
      );
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
    throw err;
  };

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
