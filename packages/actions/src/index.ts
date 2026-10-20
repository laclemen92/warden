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
}

/**
 * Everything `run` may do to data. Entities are config-style table keys (`users`,
 * `billing.invoices`); fields, values and filters are checked exactly as for client input, so a
 * hidden table or column is indistinguishable from a nonexistent one. Every write must be covered
 * by the action's `permissions`, and each changed row is audited under the action's entry.
 */
export interface ActionTx {
  /** The row with this id, or null when there is none. */
  get(entity: string, id: string | RecordRef): Promise<RecordRef | null>;
  /** Up to `limit` (default 100, at most 1000) matching rows. `sort` is as in the list API. */
  list(
    entity: string,
    opts?: { filter?: Filter; sort?: string; limit?: number },
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
  /** Require a reason, as configurable writes do. Config can also turn this on. */
  requireReason?: boolean;
  /** Max rows `run` may change; exceeding it fails the action. Default 1000. */
  maxAffectedRows?: number;
  /** Statement timeout for the transaction. Default: the server's (15 s). */
  timeoutMs?: number;
  run: (ctx: RunContext<InputOf<I>, T>) => Promise<ActionResult | void>;
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
  constructor(
    message: string,
    readonly errors: FieldError[] = [],
  ) {
    super(message);
    this.name = 'ActionValidationError';
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
