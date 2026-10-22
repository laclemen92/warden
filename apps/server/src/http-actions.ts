import { createHash, createHmac } from 'node:crypto';
import type { Actor } from '@wardenhq/actions';
import {
  apiBodyMessage,
  checkActionUrl,
  cleanApiMessage,
  type HttpActionOutcome,
  type HttpActionSpec,
  type HttpAuthSpec,
  type HttpCallResult,
  type ResolvedAction,
} from '@wardenhq/core';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { LoadedAction } from './actions.js';

/**
 * Gets the signed-in user's access token for an API, for `http.auth: { type: 'user' }`. Built
 * from the session's stored tokens; Warden passes it in from `createWarden`.
 */
export interface UserTokenProvider {
  /** The API audiences login asks for. An action asking for another fails startup. */
  audiences: readonly string[];
  /**
   * The caller's access token for `audience`, refreshed if it is about to expire. Throws
   * `SignInAgainError` when there is none or it can't be refreshed.
   */
  accessTokenFor(req: FastifyRequest, audience: string): Promise<string>;
}

/** The user's API token is missing, expired or revoked; they get a 401 telling them to sign in. */
export class SignInAgainError extends Error {
  constructor() {
    super('Sign in again to continue');
    this.name = 'SignInAgainError';
  }
}

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
  records: string[];
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
  },
): { http: HttpActions; problems: string[] } {
  const { env, allowHttp, userTokens } = options;
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
        const secret = auth.secretEnv !== undefined ? secretOf(auth.secretEnv) : undefined;
        authenticator = {
          retryOn401: true,
          credentials: async (_req, retry = false) => ({
            bearer: await cache.token(auth, clientId, clientSecret, retry),
            ...(secret ? { secret } : {}),
          }),
        };
        break;
      }
      case 'user': {
        if (!userTokens) {
          problem(
            'http.auth type "user" needs the signed-in user\'s API token, but this Warden has no ' +
              'user token support configured; use "hmac" or "client_credentials"',
          );
        } else if (!userTokens.audiences.includes(auth.audience)) {
          problem(`http.auth.audience "${auth.audience}" is not an audience login requests`);
        }
        authenticator = {
          retryOn401: false,
          credentials: async (req) => ({
            bearer: await userTokens!.accessTokenFor(req, auth.audience),
          }),
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
  status?: number;
  timedOut?: boolean;
  message?: string;
  resultId?: string;
  /** Per-record results the API reported, keyed by Warden record id. */
  records?: { id: string; result: HttpCallResult; message?: string }[];
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
  context: Omit<WardenContext, 'records'>;
  credentials: Credentials;
  log: FastifyBaseLogger;
}

/** Make one request, retrying once with fresh credentials after a 401 when that can help. */
async function callOnce(
  options: HttpRunOptions,
  plan: HttpRequestPlan,
  idempotencyKey: string,
): Promise<CallOutcome> {
  const { req, action, method, context, log } = options;
  let credentials = options.credentials;
  for (let attempt = 0; ; attempt++) {
    const url = new URL(plan.url);
    const contextHeader = Buffer.from(
      JSON.stringify({ ...context, records: plan.records } satisfies WardenContext),
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
        signal: AbortSignal.timeout(action.spec.timeoutMs),
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
      try {
        credentials = await action.authenticator.credentials(req, true);
      } catch (err) {
        log.error({ err }, 'could not renew the M2M token');
        return { result: 'failed', status };
      }
      continue;
    }
    const body = parseBody(res, text);
    if (status >= 200 && status < 300) {
      const message = apiBodyMessage(body);
      const resultId = idOf((body as { id?: unknown } | null)?.id);
      const records = reportedRecords(body, plan.records);
      return {
        result: 'ok',
        status,
        ...(message ? { message } : {}),
        ...(resultId ? { resultId } : {}),
        ...(records ? { records } : {}),
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

/** Run every planned request (several at once with `perRecord`) and sum up the outcome. */
export async function runHttpAction(
  options: HttpRunOptions & { auditId: string },
): Promise<HttpRunResult> {
  const { action, method, plans, auditId } = options;
  const endpoint = endpointOf(method, plans[0]?.url ?? '');
  const perRecord = action.spec.perRecord;
  const outcomes: CallOutcome[] = new Array(plans.length);
  let next = 0;
  const worker = async () => {
    while (next < plans.length) {
      const i = next++;
      // One key per request, so retrying any of them is safe.
      const key = perRecord ? `${auditId}.${i + 1}` : auditId;
      outcomes[i] = await callOnce(options, plans[i]!, key);
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
  const outcome: HttpRunResult['outcome'] = {
    endpoint,
    result: o.result,
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
  if (o.result === 'ok') return o.message;
  if (o.result === 'rejected') {
    return (
      o.message ?? (o.status === 401 || o.status === 403 ? FORBIDDEN_MESSAGE : REJECTED_MESSAGE)
    );
  }
  return o.timedOut ? TIMEOUT_MESSAGE : FAILED_MESSAGE;
}

/** The actor as the API sees it in the context header. */
export const contextActor = (actor: Actor): WardenContext['actor'] => ({
  subject: actor.subject,
  ...(actor.email ? { email: actor.email } : {}),
  ...(actor.userId ? { userId: actor.userId } : {}),
  roles: actor.roles,
});
