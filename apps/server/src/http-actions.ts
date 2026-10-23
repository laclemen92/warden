import { createHash, createHmac } from 'node:crypto';
import { ActionError, type Actor, type StepResponse } from '@wardenhq/actions';
import {
  apiBodyMessage,
  auditedBody,
  checkActionUrl,
  cleanApiMessage,
  compensationIdempotencyKey,
  guardRedacted,
  stepIdempotencyKey,
  type HttpActionOutcome,
  type HttpActionSpec,
  type HttpAuthSpec,
  type HttpCallResult,
  type HttpStepOutcome,
  type HttpStepSpec,
  type ResolvedAction,
  type StepsProgress,
} from '@wardenhq/core';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { LoadedAction } from './actions.js';

/**
 * The signed-in user's API access token, for `http.auth: { type: 'user' }`. Shaped like the
 * session's `accessTokenFor` and the OIDC client's `audience`, which `createWarden` will
 * pass in once sessions keep API tokens; until then a `user`-auth action fails startup.
 */
export interface UserTokenProvider {
  /** The API audience login requests. An action naming another fails startup. */
  audience: string | undefined;
  /**
   * The caller's access token for `audience`, refreshed if it is about to expire. Throws an error
   * named `SignInAgainError` when there is none or it can't be refreshed.
   */
  accessTokenFor(req: FastifyRequest): Promise<string>;
}

/**
 * The user's API token is missing, expired or revoked; they get a 401 telling them to sign in.
 * Checked by name, since the session store defines the error.
 */
export const isSignInAgain = (err: unknown): err is Error =>
  err instanceof Error && err.name === 'SignInAgainError';

/** Largest API response body Warden reads; the rest is ignored. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const TOKEN_TIMEOUT_MS = 10_000;
/** A cached M2M token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

export const SIGNATURE_VERSION = 'v1';
export const HEADERS = {
  context: 'x-warden-context',
  timestamp: 'x-warden-timestamp',
  signature: 'x-warden-signature',
  idempotencyKey: 'idempotency-key',
} as const;

/** One request an HTTP action makes, built from the module's `url` and `body`. */
export interface HttpRequestPlan {
  url: string;
  /** The JSON body, serialized. */
  body: string;
  /** Warden ids of the records this request is about. */
  records: string[];
}

/** Who ran the action and why, sent with every request (signed in the non-user modes). */
export interface WardenContext {
  action: string;
  auditId: string;
  requestId: string;
  actor: { subject: string; email?: string; userId?: string; roles: readonly string[] };
  reason?: string;
  /** The request's record ids, as many as fit in `MAX_CONTEXT_RECORD_BYTES`. */
  records: string[];
  /** How many records the request is about; more than `records` holds when they didn't fit. */
  recordCount: number;
}

/**
 * Budget for record ids in `X-Warden-Context`. With a maximal reason the header stays under 8 KiB,
 * nginx's default limit; the full list is in the (signed) body.
 */
export const MAX_CONTEXT_RECORD_BYTES = 2048;

function contextRecords(ids: readonly string[]): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const id of ids) {
    size += Buffer.byteLength(JSON.stringify(id)) + 1;
    if (size > MAX_CONTEXT_RECORD_BYTES) break;
    kept.push(id);
  }
  return kept;
}

/** The string an HMAC signature covers. */
export function signingString(parts: {
  method: string;
  path: string;
  timestamp: string;
  context: string;
  body: string;
}): string {
  const bodyHash = createHash('sha256').update(parts.body).digest('hex');
  return [
    SIGNATURE_VERSION,
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.context,
    bodyHash,
  ].join('\n');
}

export const signRequest = (secret: string, parts: Parameters<typeof signingString>[0]) =>
  `${SIGNATURE_VERSION}=${createHmac('sha256', secret).update(signingString(parts)).digest('hex')}`;

/** How a request authenticates, resolved per run. */
export type Credentials = { bearer?: string; secret?: string };

interface Authenticator {
  /** Credentials for a run; `retry` forces a fresh M2M token after a 401. */
  credentials(req: FastifyRequest, retry?: boolean): Promise<Credentials>;
  /** Whether a 401 is worth one retry with fresh credentials. */
  retryOn401: boolean;
}

/** M2M tokens by token endpoint, client and audience, shared by every action that uses them. */
class ClientCredentialsCache {
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private pending = new Map<string, Promise<string>>();

  async token(
    auth: Extract<HttpAuthSpec, { type: 'client_credentials' }>,
    clientId: string,
    clientSecret: string,
    force: boolean,
  ): Promise<string> {
    const key = JSON.stringify([auth.tokenUrl, clientId, auth.audience ?? '', auth.scope ?? '']);
    const cached = this.tokens.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    // Concurrent runs share one request.
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const request = this.fetchToken(auth, clientId, clientSecret)
      .then(({ token, expiresIn }) => {
        this.tokens.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 - TOKEN_MARGIN_MS });
        return token;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async fetchToken(
    auth: Extract<HttpAuthSpec, { type: 'client_credentials' }>,
    clientId: string,
    clientSecret: string,
  ) {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(auth.audience ? { audience: auth.audience } : {}),
      ...(auth.scope ? { scope: auth.scope } : {}),
    });
    const res = await fetch(auth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    const text = await readCapped(res);
    if (!res.ok) {
      throw new TokenError(`token endpoint answered ${res.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TokenError('token endpoint did not return JSON');
    }
    const { access_token: token, expires_in: expiresIn } = (body ?? {}) as Record<string, unknown>;
    if (typeof token !== 'string' || !token) {
      throw new TokenError('token endpoint returned no access_token');
    }
    return {
      token,
      expiresIn: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 300,
    };
  }
}

/** Getting an M2M token failed. Its message names no secrets. */
class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

/** An HTTP action, ready to call: its settings, credentials and definition hooks. */
export interface HttpAction {
  spec: HttpActionSpec;
  authenticator: Authenticator;
}

export interface HttpActions {
  actions: ReadonlyMap<string, HttpAction>;
  allowHttp: boolean;
}

/** Most steps a multi-step HTTP action may have, unless `WARDEN_ACTION_MAX_STEPS` says otherwise. */
export const DEFAULT_MAX_STEPS = 5;

/** `WARDEN_ACTION_MAX_STEPS`: a whole number from 1 to 20; 5 by default. */
export function parseMaxSteps(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return DEFAULT_MAX_STEPS;
  const n = /^\d+$/.test(text) ? Number(text) : 0;
  if (n < 1 || n > 20)
    throw new Error('WARDEN_ACTION_MAX_STEPS must be a whole number from 1 to 20');
  return n;
}

/** `WARDEN_ACTION_ALLOW_HTTP`: off by default. */
export function parseAllowHttp(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() || 'false';
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error('WARDEN_ACTION_ALLOW_HTTP must be true or false');
}

/**
 * Check every enabled HTTP action against the environment and get its credentials ready. Returns
 * the problems, which fail startup: a secret variable that isn't set, a fixed URL or token URL
 * that isn't https, or `user` auth with no provider for its audience.
 */
export function prepareHttpActions(
  loaded: readonly LoadedAction[],
  enabled: ReadonlyMap<string, ResolvedAction>,
  options: {
    env: Record<string, string | undefined>;
    allowHttp: boolean;
    userTokens?: UserTokenProvider | undefined;
    /** Most steps an action may have. Default `DEFAULT_MAX_STEPS`. */
    maxSteps?: number;
  },
): { http: HttpActions; problems: string[] } {
  const { env, allowHttp, userTokens, maxSteps = DEFAULT_MAX_STEPS } = options;
  const problems: string[] = [];
  const actions = new Map<string, HttpAction>();
  const cache = new ClientCredentialsCache();
  for (const { spec } of loaded) {
    if (!spec.http || !enabled.has(spec.name)) continue;
    const http = spec.http;
    const problem = (message: string) => problems.push(`action "${spec.name}": ${message}`);
    const before = problems.length;
    const secretOf = (name: string) => {
      const value = env[name];
      if (!value) problem(`environment variable ${name} is not set`);
      return value ?? '';
    };
    if (http.url !== undefined) {
      const bad = checkActionUrl(http.url, allowHttp);
      if (bad) problem(`http.url ${bad}`);
    }
    if (http.steps && http.steps.length > maxSteps) {
      problem(
        `http.steps has ${http.steps.length} steps; at most ${maxSteps} are allowed ` +
          '(WARDEN_ACTION_MAX_STEPS)',
      );
    }
    for (const [i, step] of (http.steps ?? []).entries()) {
      const bad = step.url !== undefined ? checkActionUrl(step.url, allowHttp) : undefined;
      if (bad) problem(`http.steps[${i}].url ${bad}`);
      const undo = step.compensate?.url;
      const badUndo = undo !== undefined ? checkActionUrl(undo, allowHttp) : undefined;
      if (badUndo) problem(`http.steps[${i}].compensate.url ${badUndo}`);
    }
    const auth = http.auth;
    let authenticator: Authenticator;
    switch (auth.type) {
      case 'hmac': {
        const secret = secretOf(auth.secretEnv);
        authenticator = { retryOn401: false, credentials: async () => ({ secret }) };
        break;
      }
      case 'client_credentials': {
        const bad = checkActionUrl(auth.tokenUrl, allowHttp);
        if (bad) problem(`http.auth.tokenUrl ${bad}`);
        const clientId = secretOf(auth.clientIdEnv);
        const clientSecret = secretOf(auth.clientSecretEnv);
        const secret = secretOf(auth.secretEnv);
        authenticator = {
          retryOn401: true,
          credentials: async (_req, retry = false) => ({
            bearer: await cache.token(auth, clientId, clientSecret, retry),
            secret,
          }),
        };
        break;
      }
      case 'user': {
        if (!userTokens) {
          problem('http.auth type "user" needs a provider of users\' API tokens');
        } else if (userTokens.audience === undefined) {
          problem(
            `http.auth type "user" needs OIDC_AUDIENCE set to "${auth.audience}", so sign-in ` +
              'keeps an access token for it',
          );
        } else if (userTokens.audience !== auth.audience) {
          problem(`http.auth.audience "${auth.audience}" is not the audience login requests`);
        }
        authenticator = {
          retryOn401: false,
          credentials: async (req) => ({ bearer: await userTokens!.accessTokenFor(req) }),
        };
        break;
      }
    }
    if (problems.length === before) actions.set(spec.name, { spec: http, authenticator });
  }
  return { http: { actions, allowHttp }, problems };
}

/** One request's outcome. */
interface CallOutcome {
  result: HttpCallResult;
  /** Not sent: the run's deadline passed first. */
  skipped?: true;
  status?: number;
  timedOut?: boolean;
  message?: string;
  resultId?: string;
  /** Per-record results the API reported, keyed by Warden record id. */
  records?: { id: string; result: HttpCallResult; message?: string }[];
  /** A 2xx's JSON body, unless it was cut off at `MAX_RESPONSE_BYTES`. */
  json?: unknown;
}

/** The response body as text, reading at most `MAX_RESPONSE_BYTES`. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString('utf8');
}

function parseBody(res: Response, text: string): unknown {
  const type = res.headers.get('content-type') ?? '';
  if (/\bjson\b/i.test(type)) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  // HTML error pages aren't messages.
  return /^text\/plain\b/i.test(type) ? text : undefined;
}

const idOf = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 200) : undefined;

/** Per-record results a 2xx reported (`records: [{ id, ok, message }]`), for known ids only. */
function reportedRecords(body: unknown, ids: readonly string[]): CallOutcome['records'] {
  const list = (body as { records?: unknown } | null)?.records;
  if (!Array.isArray(list)) return undefined;
  const known = new Set(ids);
  const seen = new Set<string>();
  const records: NonNullable<CallOutcome['records']> = [];
  for (const item of list.slice(0, ids.length)) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, ok, message } = item as Record<string, unknown>;
    const key = idOf(id);
    if (key === undefined || !known.has(key) || seen.has(key) || typeof ok !== 'boolean') continue;
    seen.add(key);
    const text = cleanApiMessage(message);
    records.push({ id: key, result: ok ? 'ok' : 'rejected', ...(text ? { message: text } : {}) });
  }
  return records.length > 0 ? records : undefined;
}

export interface HttpRunOptions {
  req: FastifyRequest;
  action: HttpAction;
  method: HttpActionSpec['method'];
  plans: HttpRequestPlan[];
  context: Omit<WardenContext, 'records' | 'recordCount'>;
  /** Replaced when a 401 gets fresh ones, so later requests of the run use them. */
  credentials: Credentials;
  log: FastifyBaseLogger;
}

type CallOptions = Omit<HttpRunOptions, 'method' | 'plans'>;

/**
 * Make one request, retrying once with fresh credentials after a 401 when that can help. With
 * `stopAt`, the retry and the token call before it are cut off at that time too.
 */
async function callOnce(
  options: CallOptions,
  plan: HttpRequestPlan,
  idempotencyKey: string,
  {
    method,
    timeoutMs,
    stopAt,
  }: { method: HttpActionSpec['method']; timeoutMs: number; stopAt?: number },
): Promise<CallOutcome> {
  const { req, action, context, log } = options;
  let credentials = options.credentials;
  const timeLeft = () =>
    stopAt === undefined ? timeoutMs : Math.min(timeoutMs, stopAt - Date.now());
  const outOfTime = (status?: number): CallOutcome => {
    log.error({ endpoint: endpointOf(method, plan.url) }, 'action API timed out');
    return { result: 'failed', timedOut: true, ...(status !== undefined ? { status } : {}) };
  };
  for (let attempt = 0; ; attempt++) {
    const limit = timeLeft();
    if (limit <= 0) return outOfTime();
    const url = new URL(plan.url);
    const contextHeader = Buffer.from(
      JSON.stringify({
        ...context,
        records: contextRecords(plan.records),
        recordCount: plan.records.length,
      } satisfies WardenContext),
    ).toString('base64url');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      [HEADERS.idempotencyKey]: idempotencyKey,
      [HEADERS.context]: contextHeader,
      [HEADERS.timestamp]: timestamp,
    };
    if (credentials.secret) {
      headers[HEADERS.signature] = signRequest(credentials.secret, {
        method,
        path: `${url.pathname}${url.search}`,
        timestamp,
        context: contextHeader,
        body: plan.body,
      });
    }
    if (credentials.bearer) headers.authorization = `Bearer ${credentials.bearer}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: plan.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(limit),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      log.error(
        { err, endpoint: endpointOf(method, plan.url) },
        timedOut ? 'action API timed out' : 'action API unreachable',
      );
      return { result: 'failed', ...(timedOut ? { timedOut } : {}) };
    }
    const text = await readCapped(res).catch(() => '');
    const status = res.status;
    if (status === 401 && attempt === 0 && action.authenticator.retryOn401) {
      log.info({ endpoint: endpointOf(method, plan.url) }, 'action API answered 401; new token');
      let timer: NodeJS.Timeout | undefined;
      try {
        const renewed = await Promise.race([
          action.authenticator.credentials(req, true),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), Math.max(timeLeft(), 0));
          }),
        ]);
        if (!renewed) return outOfTime(status);
        credentials = renewed;
        options.credentials = credentials;
      } catch (err) {
        log.error({ err }, 'could not renew the M2M token');
        return { result: 'failed', status };
      } finally {
        clearTimeout(timer);
      }
      continue;
    }
    const body = parseBody(res, text);
    if (status >= 200 && status < 300) {
      const message = apiBodyMessage(body);
      const resultId = idOf((body as { id?: unknown } | null)?.id);
      const records = reportedRecords(body, plan.records);
      // A body that filled the buffer was probably cut off, so it isn't handed on.
      const whole = Buffer.byteLength(text) < MAX_RESPONSE_BYTES - 4;
      const json =
        whole && /\bjson\b/i.test(res.headers.get('content-type') ?? '') ? body : undefined;
      return {
        result: 'ok',
        status,
        ...(message ? { message } : {}),
        ...(resultId ? { resultId } : {}),
        ...(records ? { records } : {}),
        ...(json !== undefined ? { json } : {}),
      };
    }
    if (status >= 400 && status < 500) {
      const message = apiBodyMessage(body);
      log.info({ endpoint: endpointOf(method, plan.url), status }, 'action API rejected the call');
      return { result: 'rejected', status, ...(message ? { message } : {}) };
    }
    // 5xx, and redirects, which aren't followed.
    log.error(
      { endpoint: endpointOf(method, plan.url), status, body: text.slice(0, 2000) },
      status >= 300 && status < 400 ? 'action API redirected; not followed' : 'action API failed',
    );
    return { result: 'failed', status };
  }
}

/** Method, origin and path: the query may hold secrets, so it isn't logged or audited. */
export function endpointOf(method: string, url: string): string {
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.origin}${parsed.pathname}`;
  } catch {
    return method;
  }
}

/** What the run route sends back, and what the follow-up audit entry records. */
export interface HttpRunResult {
  statusCode: number;
  body: Record<string, unknown>;
  outcome: Omit<HttpActionOutcome, 'attempt'>;
}

const FAILED_MESSAGE = 'the API this action calls failed; try again later';
const TIMEOUT_MESSAGE = 'the API this action calls did not answer in time';
const REJECTED_MESSAGE = 'the API this action calls rejected it';
const FORBIDDEN_MESSAGE = 'the API this action calls says you are not allowed to do this';

const SKIPPED_MESSAGE = 'not attempted: the action ran out of time';

/**
 * Run every planned request (several at once with `perRecord`) and sum up the outcome. No request
 * starts after `deadlineMs`, so a run takes at most that plus one request's timeout.
 */
export async function runHttpAction(
  options: HttpRunOptions & { auditId: string; deadlineMs: number },
): Promise<HttpRunResult> {
  const { action, method, plans, auditId } = options;
  const endpoint = endpointOf(method, plans[0]?.url ?? '');
  const perRecord = action.spec.perRecord;
  const stopAt = Date.now() + options.deadlineMs;
  const outcomes: CallOutcome[] = plans.map(() => ({ result: 'failed', skipped: true }));
  let next = 0;
  const worker = async () => {
    while (next < plans.length && Date.now() < stopAt) {
      const i = next++;
      // One key per request, so retrying any of them is safe.
      const key = perRecord ? `${auditId}.${i + 1}` : auditId;
      outcomes[i] = await callOnce(options, plans[i]!, key, {
        method,
        timeoutMs: action.spec.timeoutMs,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(perRecord ? action.spec.concurrency : 1, plans.length) }, worker),
  );

  if (perRecord) {
    const records = plans.map((plan, i) => {
      const o = outcomes[i]!;
      return {
        id: plan.records[0]!,
        result: o.result,
        ...(o.status !== undefined ? { status: o.status } : {}),
        ...(o.result !== 'failed' && o.message ? { message: o.message } : {}),
        ...(o.skipped ? { message: SKIPPED_MESSAGE } : {}),
      };
    });
    const ok = records.filter((r) => r.result === 'ok').length;
    const message =
      ok === records.length
        ? `Done for all ${records.length} records.`
        : `Done for ${ok} of ${records.length} records.`;
    return {
      statusCode: 200,
      body: {
        auditId,
        result: {
          message,
          records: records.map((r, i) => {
            const text = userMessage(outcomes[i]!);
            return { id: r.id, ok: r.result === 'ok', ...(text ? { message: text } : {}) };
          }),
        },
      },
      outcome: {
        endpoint,
        result: ok === records.length ? 'ok' : ok === 0 ? 'failed' : 'partial',
        records,
      },
    };
  }

  const o = outcomes[0]!;
  const records = o.records;
  const rejected = records?.filter((r) => r.result !== 'ok').length ?? 0;
  const outcome: HttpRunResult['outcome'] = {
    endpoint,
    result:
      o.result === 'ok' && rejected > 0
        ? rejected === plans[0]!.records.length
          ? 'rejected'
          : 'partial'
        : o.result,
    ...(o.status !== undefined ? { status: o.status } : {}),
    ...(o.result !== 'failed' && o.message ? { message: o.message } : {}),
    ...(o.resultId ? { resultId: o.resultId } : {}),
    ...(records ? { records } : {}),
  };
  if (o.result === 'ok') {
    return {
      statusCode: 200,
      body: {
        auditId,
        result: {
          ...(o.message ? { message: o.message } : {}),
          ...(records
            ? {
                records: records.map((r) => ({
                  id: r.id,
                  ok: r.result === 'ok',
                  ...(r.message ? { message: r.message } : {}),
                })),
              }
            : {}),
        },
      },
      outcome,
    };
  }
  if (o.result === 'rejected') {
    const forbidden = o.status === 401 || o.status === 403;
    return {
      statusCode: forbidden ? 403 : 400,
      body: {
        statusCode: forbidden ? 403 : 400,
        error: forbidden ? 'Forbidden' : 'Bad Request',
        message: o.message ?? (forbidden ? FORBIDDEN_MESSAGE : REJECTED_MESSAGE),
        auditId,
      },
      outcome,
    };
  }
  const statusCode = o.timedOut ? 504 : 502;
  return {
    statusCode,
    body: {
      statusCode,
      error: o.timedOut ? 'Gateway Timeout' : 'Bad Gateway',
      message: o.timedOut ? TIMEOUT_MESSAGE : FAILED_MESSAGE,
      auditId,
    },
    outcome,
  };
}

/** What the user is told about one request's outcome. */
function userMessage(o: CallOutcome): string | undefined {
  if (o.skipped) return SKIPPED_MESSAGE;
  if (o.result === 'ok') return o.message;
  if (o.result === 'rejected') {
    return (
      o.message ?? (o.status === 401 || o.status === 403 ? FORBIDDEN_MESSAGE : REJECTED_MESSAGE)
    );
  }
  return o.timedOut ? TIMEOUT_MESSAGE : FAILED_MESSAGE;
}

/**
 * On a retry, a later step read the body of an earlier step whose body wasn't kept, so the
 * request can't be rebuilt.
 */
export class MissingStepResponse extends Error {
  constructor(readonly step: string) {
    super(`step "${step}" kept no response body to retry with`);
    this.name = 'MissingStepResponse';
  }
}

/** A step as a run sees it: its settings, and its requests built from earlier answers. */
export interface StepRunner {
  spec: HttpStepSpec;
  /** The step's request, or null when its `when` skips it. Throws what the module throws. */
  plan(prev: Record<string, StepResponse>): HttpRequestPlan | null;
  /** Its undo call's request, for a step with `compensate`. */
  compensation(prev: Record<string, StepResponse>): HttpRequestPlan;
}

export interface StepsRunOptions extends CallOptions {
  steps: readonly StepRunner[];
  /** The attempt's entry: steps' keys derive from it, on retries too. */
  auditId: string;
  deadlineMs: number;
  /** Steps that completed in earlier tries of the attempt. They aren't sent again. */
  done: StepsProgress['done'];
  /** Whether "Retry remaining steps" can be offered if this fails. */
  retryable: boolean;
}

/** How one step went, as the user is told. */
export interface StepView {
  name: string;
  result: HttpStepOutcome['result'];
  message?: string;
  compensation?: { result: HttpCallResult; message?: string };
}

const STEP_BUILD_MESSAGE = "the action couldn't build this step's request";
const RETRY_STATE_MESSAGE =
  "can't retry: this step needs an earlier step's response, which wasn't kept; run the action again";
const COMPENSATION_FAILED = 'undoing this step failed';

interface StepFailure {
  statusCode: number;
  error: string;
  message: string;
}

/** The user-facing failure for a step's outcome. */
function stepFailure(o: CallOutcome): StepFailure {
  if (o.result === 'rejected') {
    const forbidden = o.status === 401 || o.status === 403;
    return {
      statusCode: forbidden ? 403 : 400,
      error: forbidden ? 'Forbidden' : 'Bad Request',
      message: o.message ?? (forbidden ? FORBIDDEN_MESSAGE : REJECTED_MESSAGE),
    };
  }
  return o.timedOut
    ? { statusCode: 504, error: 'Gateway Timeout', message: TIMEOUT_MESSAGE }
    : { statusCode: 502, error: 'Bad Gateway', message: FAILED_MESSAGE };
}

/**
 * An earlier try's answer. Its body is there only if the step kept it, and its redacted values
 * aren't there at all.
 */
function restoredResponse(name: string, done: { status?: number; body?: unknown; kept: boolean }) {
  const missing = () => {
    throw new MissingStepResponse(name);
  };
  return Object.freeze({
    status: done.status ?? 200,
    get body(): unknown {
      if (!done.kept) missing();
      return guardRedacted(done.body, missing);
    },
  });
}

/**
 * Run a multi-step action's steps in order, from the first one not done yet. The first failure
 * stops the chain: later steps aren't called, and the steps that completed are undone in reverse
 * order where they have `compensate` (best effort). No step starts after the deadline, and a step
 * in flight is cut off at it.
 */
export async function runHttpSteps(options: StepsRunOptions): Promise<HttpRunResult> {
  const { steps, auditId, log, done } = options;
  const stopAt = Date.now() + options.deadlineMs;
  const prev: Record<string, StepResponse> = {};
  for (const [name, d] of done) if (d.result === 'ok') prev[name] = restoredResponse(name, d);
  const outcomes: HttpStepOutcome[] = [];
  /** What the user is told about each step, by index. */
  const shown: (string | undefined)[] = [];
  const completed: number[] = [];
  // In an object, since `fail` sets it.
  const state: { failure?: StepFailure & { step: HttpStepOutcome } } = {};
  let lastMessage: string | undefined;
  const fail = (step: HttpStepOutcome, f: StepFailure) => {
    state.failure = { ...f, step };
    shown[outcomes.length] = f.message;
    outcomes.push(step);
  };

  for (const [i, { spec, plan: planOf }] of steps.entries()) {
    const { name } = spec;
    const earlier = done.get(name);
    if (state.failure) {
      outcomes.push({ name, result: 'not_attempted' });
      continue;
    }
    if (earlier) {
      outcomes.push({ name, result: earlier.result, earlier: true });
      if (earlier.result === 'ok') completed.push(i);
      continue;
    }
    let plan: HttpRequestPlan | null;
    try {
      plan = planOf({ ...prev });
    } catch (err) {
      if (err instanceof ActionError) {
        const message = cleanApiMessage(err.message) ?? REJECTED_MESSAGE;
        fail(
          { name, result: 'rejected', message },
          { statusCode: 400, error: 'Bad Request', message },
        );
      } else if (err instanceof MissingStepResponse) {
        fail(
          { name, result: 'failed', message: RETRY_STATE_MESSAGE },
          { statusCode: 409, error: 'Conflict', message: RETRY_STATE_MESSAGE },
        );
      } else {
        log.error({ err, step: name }, 'could not build the step request');
        fail(
          { name, result: 'failed', message: STEP_BUILD_MESSAGE },
          { statusCode: 500, error: 'Internal Server Error', message: STEP_BUILD_MESSAGE },
        );
      }
      continue;
    }
    if (!plan) {
      outcomes.push({ name, result: 'skipped' });
      continue;
    }
    const endpoint = endpointOf(spec.method, plan.url);
    const remaining = stopAt - Date.now();
    if (remaining <= 0) {
      fail(
        { name, result: 'not_attempted', endpoint, message: SKIPPED_MESSAGE },
        { statusCode: 504, error: 'Gateway Timeout', message: SKIPPED_MESSAGE },
      );
      continue;
    }
    const started = Date.now();
    const o = await callOnce(options, plan, stepIdempotencyKey(auditId, name), {
      method: spec.method,
      timeoutMs: spec.timeoutMs,
      stopAt,
    });
    const outcome: HttpStepOutcome = {
      name,
      result: o.result,
      endpoint,
      ...(o.status !== undefined ? { status: o.status } : {}),
      durationMs: Date.now() - started,
      ...(o.result !== 'failed' && o.message ? { message: o.message } : {}),
      ...(o.resultId ? { resultId: o.resultId } : {}),
    };
    if (o.result !== 'ok') {
      fail(outcome, stepFailure(o));
      continue;
    }
    prev[name] = Object.freeze({ status: o.status!, body: o.json });
    completed.push(i);
    if (o.message) lastMessage = o.message;
    if (spec.auditBody && o.json !== undefined) {
      Object.assign(outcome, auditedBody(o.json, spec.auditBody.redact));
    }
    shown[outcomes.length] = o.message;
    outcomes.push(outcome);
  }

  const { failure } = state;
  let compensated = false;
  if (failure) {
    for (const i of completed.reverse()) {
      const { spec, compensation } = steps[i]!;
      if (!spec.compensate) continue;
      compensated = true;
      const outcome = outcomes[i]!;
      let plan: HttpRequestPlan;
      try {
        plan = compensation({ ...prev });
      } catch (err) {
        log.error({ err, step: spec.name }, 'could not build the undo request');
        outcome.compensation = { result: 'failed', message: COMPENSATION_FAILED };
        continue;
      }
      const started = Date.now();
      const o = await callOnce(options, plan, compensationIdempotencyKey(auditId, spec.name), {
        method: spec.compensate.method,
        timeoutMs: spec.compensate.timeoutMs,
      });
      outcome.compensation = {
        result: o.result,
        endpoint: endpointOf(spec.compensate.method, plan.url),
        ...(o.status !== undefined ? { status: o.status } : {}),
        durationMs: Date.now() - started,
        ...(o.result === 'rejected' && o.message ? { message: o.message } : {}),
        ...(o.result === 'failed' ? { message: COMPENSATION_FAILED } : {}),
      };
      if (o.result !== 'ok') {
        log.warn({ step: spec.name, result: o.result, status: o.status }, 'undo call failed');
      }
    }
  }

  const views: StepView[] = outcomes.map((o, i) => ({
    name: o.name,
    result: o.result,
    ...(shown[i] ? { message: shown[i] } : {}),
    ...(o.compensation
      ? {
          compensation: {
            result: o.compensation.result,
            ...(o.compensation.message ? { message: o.compensation.message } : {}),
          },
        }
      : {}),
  }));
  const step = failure?.step;
  const outcome: HttpRunResult['outcome'] = {
    result: !failure
      ? 'ok'
      : outcomes.some((o) => o.result === 'ok')
        ? 'partial'
        : step?.result === 'rejected'
          ? 'rejected'
          : 'failed',
    ...(step?.status !== undefined ? { status: step.status } : {}),
    steps: outcomes,
  };
  if (!failure) {
    return {
      statusCode: 200,
      body: { auditId, result: { ...(lastMessage ? { message: lastMessage } : {}), steps: views } },
      outcome,
    };
  }
  return {
    statusCode: failure.statusCode,
    body: {
      statusCode: failure.statusCode,
      error: failure.error,
      message: failure.message,
      auditId,
      steps: views,
      retryable: options.retryable && !compensated,
    },
    outcome,
  };
}

/** The actor as the API sees it in the context header. */
export const contextActor = (actor: Actor): WardenContext['actor'] => ({
  subject: actor.subject,
  ...(actor.email ? { email: actor.email } : {}),
  ...(actor.userId ? { userId: actor.userId } : {}),
  roles: actor.roles,
});
