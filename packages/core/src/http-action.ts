import type { HttpStepSpec } from './actions.js';
import type { HttpActionOutcome } from './audit.js';

/** Why an HTTP action may not call `url`, if it may not. */
export function checkActionUrl(url: string, allowHttp: boolean): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a valid URL';
  }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol !== 'http:') return 'must use https';
  if (allowHttp || isLoopback(parsed.hostname)) return undefined;
  return 'must use https (http is allowed only on loopback, or with WARDEN_ACTION_ALLOW_HTTP=true)';
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Longest API message shown to a user. */
export const MAX_API_MESSAGE_LENGTH = 300;

/**
 * Text from an API made safe to show: tags and control characters removed, whitespace collapsed,
 * and length capped. Undefined when nothing is left.
 */
export function cleanApiMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .slice(0, 10_000)
    .replace(/<[^>]*>?/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > MAX_API_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_API_MESSAGE_LENGTH - 1).trimEnd()}…`
    : text;
}

/**
 * The message an API put in a JSON body: `message`, or `error` when it's text
 * (`{ error: 'Not found' }`), or the first of a `message` list (NestJS validation errors).
 */
export function apiBodyMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return cleanApiMessage(body);
  if (typeof body !== 'object' || body === null) return undefined;
  const { message, error } = body as Record<string, unknown>;
  if (Array.isArray(message)) return cleanApiMessage(message[0]);
  return cleanApiMessage(message) ?? cleanApiMessage(error);
}

/** The `Idempotency-Key` of a multi-step action's step: the same on every retry of the attempt. */
export const stepIdempotencyKey = (auditId: string, step: string) => `${auditId}.${step}`;

/** The `Idempotency-Key` of a step's undo call. */
export const compensationIdempotencyKey = (auditId: string, step: string) =>
  `${auditId}.${step}.compensate`;

/** Largest response body a step keeps in the audit log, as JSON, after redaction. */
export const MAX_AUDIT_BODY_BYTES = 8 * 1024;
const MAX_REDACT_DEPTH = 32;
/** What `redactJson` puts in place of a redacted value. */
export const REDACTED = '[redacted]';
/** What `redactJson` puts in place of a value nested too deep to check. */
export const TOO_DEEP = '[too deep]';

/** `value` with the values of `keys` (case-insensitive, at any depth) replaced by `[redacted]`. */
export function redactJson(value: unknown, keys: readonly string[]): unknown {
  const redacted = new Set(keys.map((k) => k.toLowerCase()));
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v !== 'object' || v === null) return v;
    if (depth >= MAX_REDACT_DEPTH) return TOO_DEEP;
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    return Object.fromEntries(
      Object.entries(v).map(([k, item]) => [
        k,
        redacted.has(k.toLowerCase()) ? REDACTED : walk(item, depth + 1),
      ]),
    );
  };
  return walk(value, 0);
}

/** A step's response body as the audit log keeps it: redacted, or left out when too large. */
export function auditedBody(
  body: unknown,
  redact: readonly string[],
): { body: unknown } | { bodyOmitted: true } {
  const kept = redactJson(body, redact);
  const size = new TextEncoder().encode(JSON.stringify(kept) ?? '').length;
  return size > MAX_AUDIT_BODY_BYTES ? { bodyOmitted: true } : { body: kept };
}

/**
 * A kept (redacted) body that calls `missing` when a redacted value is read, so a retry never
 * sends the placeholder in place of the real value.
 */
export function guardRedacted(body: unknown, missing: () => never): unknown {
  const wrapped = new WeakMap<object, object>();
  const wrap = (value: unknown): unknown => {
    if (value === REDACTED || value === TOO_DEEP) missing();
    if (typeof value !== 'object' || value === null) return value;
    let proxy = wrapped.get(value);
    if (!proxy) {
      // Spread, `Object.entries` and `JSON.stringify` read through `get` too.
      proxy = new Proxy(value, {
        get: (target, key, receiver) => wrap(Reflect.get(target, key, receiver)),
      });
      wrapped.set(value, proxy);
    }
    return proxy;
  };
  return wrap(body);
}

/** Where an attempt of a multi-step action stands, from its outcome entries. */
export interface StepsProgress {
  /** Steps that completed (or were skipped) in some attempt, by name. */
  done: Map<string, { result: 'ok' | 'skipped'; status?: number; body?: unknown; kept: boolean }>;
  /** An undo call was made, so the steps that completed may have been undone. */
  compensated: boolean;
  /** Every step is done. */
  finished: boolean;
}

/** What an attempt's outcome entries say about its steps, for "Retry remaining steps". */
export function stepsProgress(
  steps: readonly HttpStepSpec[],
  outcomes: readonly HttpActionOutcome[],
): StepsProgress {
  const done: StepsProgress['done'] = new Map();
  let compensated = false;
  for (const outcome of outcomes) {
    for (const step of outcome.steps ?? []) {
      if (step.compensation) compensated = true;
      if (step.earlier || (step.result !== 'ok' && step.result !== 'skipped')) continue;
      done.set(step.name, {
        result: step.result,
        ...(step.status !== undefined ? { status: step.status } : {}),
        ...('body' in step ? { body: step.body } : {}),
        kept: 'body' in step,
      });
    }
  }
  return { done, compensated, finished: steps.every((s) => done.has(s.name)) };
}
