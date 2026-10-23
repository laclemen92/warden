import type { FieldError, Filter } from '@wardenhq/core';
import type { z } from 'zod';

export type { FieldError, Filter };

/**
 * Version of the API Warden passes to an actions module (`api.apiVersion`). A module may also
 * `export const apiVersion` to say which version it was written against; Warden refuses to load
 * one newer than its own.
 */
export const API_VERSION = 1;

/** What an action runs against: one record, a selection of records, or the entity as a whole. */
export type ActionTarget = 'one' | 'many' | 'none';

export type ActionWrite = 'create' | 'update' | 'delete';

/** The signed-in user running the action. */
export interface Actor {
  subject: string;
  email?: string;
  name?: string;
  /**
   * Their id in your own users table, when config's `actor` maps them to one. Resolved at sign-in,
   * and also set as `warden.actor_id` for the action's transaction.
   */
  userId?: string;
  roles: readonly string[];
}

/** A row as an action sees it. */
export interface RecordRef {
  /** Entity key, as in API URLs (`users`, `billing.invoices`). */
  entity: string;
  /** The API's opaque record id. */
  id: string;
  /** The row's display field value, as text. */
  label: string;
  /** Exposed fields only: columns config hides are absent. */
  values: Record<string, unknown>;
}

export interface ActionResult {
  /** Shown to the user when the action finishes. */
  message?: string;
  /** Where the UI goes next, e.g. the record the action created. */
  redirect?: { entity: string; id: string };
  /** HTTP actions on many records: how each one went. */
  records?: { id: string; ok: boolean; message?: string }[];
}

/**
 * Everything `run` may do to data. Entities are config-style table keys (`users`,
 * `billing.invoices`); fields, values and filters are checked exactly as for client input, so a
 * hidden table or column is indistinguishable from a nonexistent one. Every write must be covered
 * by the action's `permissions`, and each changed row is audited under the action's entry.
 * Await every call. A database error fails the whole action, even if `run` catches it: Postgres
 * has aborted the transaction, so later calls throw it again and nothing commits.
 */
export interface ActionTx {
  /**
   * The row with this id, or null when there is none. With `lock`, the row is locked
   * (`select ... for update`) until the action ends, so another run can't change it between
   * reading it here and writing it back.
   */
  get(entity: string, id: string | RecordRef, opts?: { lock?: boolean }): Promise<RecordRef | null>;
  /**
   * Up to `limit` (default 100, at most 1000) matching rows. `sort` is as in the list API. With
   * `lock`, the rows returned are locked until the action ends, as for `get`.
   */
  list(
    entity: string,
    opts?: { filter?: Filter; sort?: string; limit?: number; lock?: boolean },
  ): Promise<RecordRef[]>;
  create(entity: string, values: Record<string, unknown>): Promise<RecordRef>;
  update(
    entity: string,
    target: string | RecordRef,
    values: Record<string, unknown>,
  ): Promise<RecordRef>;
  delete(entity: string, target: string | RecordRef): Promise<void>;
  /** Update every row matching `filter`; returns how many changed. */
  updateMany(entity: string, filter: Filter, values: Record<string, unknown>): Promise<number>;
  /** Delete every row matching `filter`; returns how many were deleted. */
  deleteMany(entity: string, filter: Filter): Promise<number>;
}

type LogFn = {
  (msg: string): void;
  (obj: object, msg?: string): void;
};

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export interface RunContext<I, T extends ActionTarget = ActionTarget> {
  input: I;
  /** The target record, loaded and locked before `run` starts (`target: 'one'`). */
  record: T extends 'one' ? RecordRef : undefined;
  /** The selected records, loaded and locked before `run` starts (`target: 'many'`). */
  records: T extends 'many' ? RecordRef[] : undefined;
  tx: ActionTx;
  actor: Actor;
  reason?: string;
  /**
   * Runs after the commit; skipped in preview and on rollback. Its errors are logged, not
   * returned. Put side effects outside the database (emails, webhooks) here: preview runs `run`
   * for real and rolls it back, so anything else `run` does happens on every preview too.
   */
  afterCommit(fn: () => Promise<void>): void;
  log: Logger;
}

/** The record id on the wire; the loaded record in `run`. */
export type RefSchema = z.ZodType<RecordRef, string>;

type InputOf<I> = I extends z.ZodObject ? z.output<I> : Record<string, never>;
type DefaultsOf<I> = I extends z.ZodObject ? Partial<z.input<I>> : Record<string, never>;

export interface ActionDefinition<
  I extends z.ZodObject | undefined = z.ZodObject | undefined,
  T extends ActionTarget = ActionTarget,
> {
  /** Stable id: grants, URLs and the audit log refer to it. `^[a-z][a-z0-9-]*$`, unique. */
  name: string;
  label: string;
  description?: string;
  /** Entity the action belongs to: a config-style table key (`users`, `billing.invoices`). */
  on: string;
  /** What the action runs against. Default `one`. */
  target?: T;
  /** Upper bound on what `run` may write. Checked at startup, at every write, and shown to users. */
  permissions: Partial<Record<string, readonly ActionWrite[]>>;
  /** Root must be `z.object`. Omit for actions without input. */
  input?: I;
  /** Prefill the form, e.g. from the target record. */
  defaults?: (ctx: { record?: RecordRef; actor: Actor }) => DefaultsOf<I> | Promise<DefaultsOf<I>>;
  /** `preview` (default): the user sees the change set before running. `confirm`: a plain confirmation. */
  confirm?: 'preview' | 'confirm';
  /** Styles the button and confirmation as destructive. */
  destructive?: boolean;
  /**
   * Require a reason (an internal note in the audit log). Default true. `actions.<name>` config
   * overrides it either way, and a table that requires a reason for a write the action may make
   * requires one too.
   */
  requireReason?: boolean;
  /** Max rows `run` may change; exceeding it fails the action. Default 1000. */
  maxAffectedRows?: number;
  /** Statement timeout for the transaction. Default: the server's (15 s). */
  timeoutMs?: number;
  /**
   * How long a run or preview may take in all before it is rolled back, its connection closed and
   * the user told it took too long. Default: the server's (`WARDEN_ACTION_DEADLINE`, 60 s).
   */
  deadlineMs?: number;
  /** What the action does, in Warden's transaction. Exactly one of `run` and `http` is given. */
  run?: (ctx: RunContext<InputOf<I>, T>) => Promise<ActionResult | void>;
  /**
   * Delegate the action to your API instead of `run`. It can't be previewed (it is always
   * `confirm: 'confirm'`), writes nothing through `tx`, and so takes no `permissions`. Give one
   * `url`, or `steps` to call several endpoints in order.
   */
  http?: HttpCall<InputOf<I>, T> | HttpSteps<InputOf<I>, T>;
}

/** What an HTTP action's `url` and `body` see. Nothing here has touched the database yet. */
export interface HttpContext<I, T extends ActionTarget = ActionTarget> {
  input: I;
  /** The target record (`target: 'one'`, or each record with `perRecord`). */
  record: T extends 'one' ? RecordRef : RecordRef | undefined;
  /** The selected records (`target: 'many'`); with `perRecord`, just this request's one. */
  records: T extends 'many' ? RecordRef[] : undefined;
  actor: Actor;
  reason?: string;
}

/**
 * How Warden authenticates to the API. No mode takes a token from the user.
 * - `hmac`: signs method, path, timestamp, body and the Warden context header with a shared
 *   secret (`X-Warden-Signature`).
 * - `client_credentials`: an M2M bearer token from your IdP, cached until it expires. The request
 *   is HMAC-signed with `secretEnv` too, so the API can trust the actor it names.
 * - `user`: the signed-in user's own access token for `audience`, so the API enforces its own
 *   permissions.
 */
export type HttpAuth =
  | { type: 'hmac'; secretEnv: string }
  | {
      type: 'client_credentials';
      tokenUrl: string;
      clientIdEnv: string;
      clientSecretEnv: string;
      audience?: string;
      scope?: string;
      secretEnv: string;
    }
  | { type: 'user'; audience: string };

export interface HttpCall<I, T extends ActionTarget = ActionTarget> {
  steps?: never;
  /** `https` only, except on loopback, unless `WARDEN_ACTION_ALLOW_HTTP=true`. */
  url: string | ((ctx: HttpContext<I, T>) => string);
  /** Default `POST`. */
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body. Default `{ input, records }`, with record ids for records. */
  body?: (ctx: HttpContext<I, T>) => unknown;
  auth: HttpAuth;
  /** Default 10 s; at most 60 s. */
  timeoutMs?: number;
  /** `target: 'many'` only: one request per record instead of one for all. */
  perRecord?: boolean;
  /** With `perRecord`, how many requests may be in flight at once. Default 4, at most 16. */
  concurrency?: number;
}

/** An earlier step's answer, as later steps see it. */
export interface StepResponse {
  status: number;
  /** The parsed JSON body; undefined when it wasn't JSON or was larger than 64 KiB. */
  body: unknown;
}

/** What the steps before this one answered, by step name. Skipped steps are absent. */
export type StepResponses = Readonly<Record<string, StepResponse>>;

/** One request of a multi-step HTTP action. */
export interface HttpStep<I, T extends ActionTarget = ActionTarget> {
  /**
   * `^[a-z][a-zA-Z0-9_]*$`, unique within the action. Later steps read this step's answer as
   * `prev.<name>`, and its `Idempotency-Key` is `<audit entry id>.<name>`.
   */
  name: string;
  /** `https` only, except on loopback, unless `WARDEN_ACTION_ALLOW_HTTP=true`. */
  url: string | ((ctx: HttpContext<I, T>, prev: StepResponses) => string);
  /** Default `POST`. */
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body. Default `{ input, records }`. */
  body?: (ctx: HttpContext<I, T>, prev: StepResponses) => unknown;
  /** Skip the step when this returns false. Skips are recorded as `skipped`. */
  when?: (ctx: HttpContext<I, T>, prev: StepResponses) => boolean;
  /** Default: `http.timeoutMs`. */
  timeoutMs?: number;
  /**
   * A call that undoes this step, made when a later step fails. Undo calls run in reverse order,
   * best effort: their outcome is logged and shown, and they are not a transaction.
   */
  compensate?: {
    url: string | ((ctx: HttpContext<I, T>, prev: StepResponses) => string);
    method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: (ctx: HttpContext<I, T>, prev: StepResponses) => unknown;
    timeoutMs?: number;
  };
  /**
   * Keep this step's JSON response body in the audit log (it isn't kept by default). Values of
   * the keys in `redact`, at any depth, are replaced with `[redacted]`.
   */
  auditBody?: true | { redact: string[] };
}

/** Several endpoints, called in order; the first failure stops the chain. */
export interface HttpSteps<I, T extends ActionTarget = ActionTarget> {
  url?: never;
  /** At most 5 (`WARDEN_ACTION_MAX_STEPS`). */
  steps: HttpStep<I, T>[];
  /** Used by every step, with the same actor headers as a single call. */
  auth: HttpAuth;
  /** Each step's default timeout. Default 10 s; at most 60 s. */
  timeoutMs?: number;
}

// Definitions differ in their input and target types, so a module's list holds any of them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDefinition = ActionDefinition<any, any>;

/** What Warden passes to an actions module. */
export interface ActionsApi {
  apiVersion: number;
  defineAction<I extends z.ZodObject | undefined = undefined, T extends ActionTarget = 'one'>(
    definition: ActionDefinition<I, T>,
  ): AnyActionDefinition;
  /** Warden's zod. Use it, not your own copy, so Warden can read the input schemas. */
  z: typeof z;
  /** An input field that picks a record of `entity`. Requires read access to it. */
  ref(entity: string): RefSchema;
  ActionError: typeof ActionError;
}

/**
 * An actions module's default export. Import only types from this package: Warden passes the
 * runtime pieces in, so the module needs no packages at runtime.
 */
export type ActionsModule = (
  api: ActionsApi,
) => readonly AnyActionDefinition[] | Promise<readonly AnyActionDefinition[]>;

/**
 * The action author's own check failed. Its message (and field) is the only part of an error the
 * user sees, so write it for them.
 */
export class ActionError extends Error {
  readonly field?: string;
  constructor(message: string, options: { field?: string } = {}) {
    super(message);
    this.name = 'ActionError';
    if (options.field !== undefined) this.field = options.field;
  }
}

/** A `tx` call was given something the entity rejects: an unknown field, a bad value or filter. */
export class ActionValidationError extends Error {
  /** Key of the entity the call addressed, so Warden can tell which fields the user may see. */
  readonly entity?: string;
  constructor(
    message: string,
    readonly errors: FieldError[] = [],
    options: { entity?: string } = {},
  ) {
    super(message);
    this.name = 'ActionValidationError';
    if (options.entity !== undefined) this.entity = options.entity;
  }
}

/** `run` wrote outside the action's `permissions`. A bug in the action; the user sees a 500. */
export class ActionPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionPermissionError';
  }
}

/** `run` changed more rows than `maxAffectedRows`. A bug in the action; the user sees a 500. */
export class ActionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionLimitError';
  }
}
