import {
  ActionLimitError,
  ActionPermissionError,
  ActionValidationError,
  type ActionTx,
  type ActionWrite as WriteAction,
  type RecordRef,
} from '@wardenhq/actions';
import {
  decodeRecordId,
  encodeRecordId,
  resolveSort,
  validateFilter,
  validateRecord,
  type Entity,
  type Filter,
  type Scalar,
} from '@wardenhq/core';
import { sql } from 'kysely';
import type { Database } from './database.js';
import { getRow, listRows, type Row } from './rows.js';
import { deleteIn, insertIn, lockRow, lockRows, updateIn, type WriteHook } from './writes.js';

/**
 * A write `run` made failed in Postgres (a constraint, a bad value). Carries what was being
 * written so the error can be mapped like a CRUD write's.
 */
export class ActionWriteError extends Error {
  constructor(
    readonly entity: Entity,
    readonly operation: WriteAction,
    cause: unknown,
  ) {
    super(`${operation} on ${entity.key} failed`, { cause });
    this.name = 'ActionWriteError';
  }
}

const isPgError = (err: unknown) =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';

const isCheckError = (err: unknown) =>
  err instanceof ActionValidationError ||
  err instanceof ActionPermissionError ||
  err instanceof ActionLimitError;

/** Run a write, tagging a Postgres error with what was being written. */
async function writing<T>(entity: Entity, operation: WriteAction, write: () => Promise<T>) {
  try {
    return await write();
  } catch (err) {
    throw isPgError(err) ? new ActionWriteError(entity, operation, err) : err;
  }
}

/** Statement timeout for the rest of a transaction, in place of the pool's. */
export async function setStatementTimeout(trx: Database, ms: number): Promise<void> {
  await sql`select set_config('statement_timeout', ${String(ms)}, true)`.execute(trx);
}

export const DEFAULT_TX_LIST_LIMIT = 100;
export const MAX_TX_LIST_LIMIT = 1000;

/** A row as actions see it. `row` must come from a query on `entity` (exposed fields only). */
export function toRecordRef(entity: Entity, row: Row): RecordRef {
  const id = encodeRecordId(entity, row) ?? '';
  const display = row[entity.displayField];
  const label =
    display === null || display === undefined
      ? id
      : typeof display === 'object'
        ? JSON.stringify(display)
        : String(display);
  const values = Object.fromEntries(entity.fields.map((f) => [f.name, row[f.name] ?? null]));
  return { entity: entity.key, id, label, values };
}

/** Equality filter on a row's primary key. */
const keyFilter = (entity: Entity, row: Row): Filter => {
  const conditions: Filter[] = entity.primaryKey.map((key) => ({
    field: key,
    op: 'eq',
    value: row[key] as Scalar,
  }));
  return conditions.length === 1 ? conditions[0]! : { and: conditions };
};

export interface ActionTxOptions {
  /** The action's name, for error messages. */
  action: string;
  /** The entity a config-style table key names; undefined when it is hidden or doesn't exist. */
  resolve: (table: string) => Entity | undefined;
  /** Entity key → the writes the action may make. */
  permissions: Readonly<Record<string, readonly WriteAction[]>>;
  /** Rows the action may change in total. */
  maxAffectedRows: number;
  /** Runs after every changed row, in the transaction: the audit entry. */
  onWrite: WriteHook;
}

export interface ActionTxHandle {
  tx: ActionTx;
  /**
   * The first database error a `tx` call hit, or undefined. Postgres aborts the transaction on
   * any error, so once there is one nothing can commit, even if `run` caught it.
   */
  readonly failure: { error: unknown } | undefined;
  /**
   * Refuse further `tx` calls and wait for the ones still running, so none overlaps the commit
   * or rollback. Returns how many were still running (calls `run` didn't await).
   */
  close(): Promise<number>;
}

/**
 * The `tx` an action's `run` gets: reads and writes inside the action's transaction that go
 * through the same validation and write path as the CRUD routes. Every write must be covered by
 * the action's permissions, locks and audits each row it changes, and counts towards
 * `maxAffectedRows`.
 */
export function createActionTx(trx: Database, options: ActionTxOptions): ActionTxHandle {
  const { action, resolve, permissions, maxAffectedRows, onWrite } = options;
  let affected = 0;
  let failure: { error: unknown } | undefined;
  let closed = false;
  const running = new Set<Promise<unknown>>();

  // Every call is tracked, and the first database error fails the transaction for good: later
  // calls rethrow it, so a `run` that catches one still can't carry on as if it hadn't happened.
  const guard =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (closed) {
        return Promise.reject(
          new Error(`action "${action}" used tx after run finished; await every tx call`),
        );
      }
      if (failure) return Promise.reject(failure.error);
      const result = (async () => {
        try {
          return await call(...args);
        } catch (err) {
          // Only Warden's own checks are known to fail before any SQL; anything else may have
          // come from Postgres (wrapped, like a failed audit insert) and aborted the transaction.
          if (!isCheckError(err)) failure ??= { error: err };
          throw err;
        }
      })();
      running.add(result);
      const done = () => void running.delete(result);
      result.then(done, done);
      return result;
    };

  // Hidden and nonexistent tables give the same error.
  const entityOf = (table: string) => {
    const entity = typeof table === 'string' ? resolve(table) : undefined;
    if (!entity) throw new ActionValidationError(`unknown entity "${String(table)}"`);
    return entity;
  };
  const permit = (entity: Entity, write: WriteAction) => {
    if (!permissions[entity.key]?.includes(write)) {
      throw new ActionPermissionError(
        `action "${action}" may not ${write} ${entity.key}; add it to the action's permissions`,
      );
    }
  };
  const count = (rows: number) => {
    if (affected + rows > maxAffectedRows) {
      throw new ActionLimitError(
        `action "${action}" would change more than ${maxAffectedRows} rows (maxAffectedRows)`,
      );
    }
    affected += rows;
  };
  const idOf = (entity: Entity, target: string | RecordRef) => {
    if (typeof target === 'object' && target !== null) {
      if (target.entity !== entity.key) {
        throw new ActionValidationError(`a ${target.entity} record is not a ${entity.key} record`);
      }
      return target.id;
    }
    return target;
  };
  /** The primary-key filter for a record id; undefined when it can't name a row. */
  const addressed = (entity: Entity, target: string | RecordRef) => {
    const id = idOf(entity, target);
    if (typeof id !== 'string') return undefined;
    const decoded = decodeRecordId(entity, id);
    return decoded.ok ? decoded.filter : undefined;
  };
  const values = (entity: Entity, input: unknown, mode: 'create' | 'update') => {
    const record = validateRecord(entity, input, mode);
    if (!record.ok) throw new ActionValidationError(`invalid ${entity.key} values`, record.errors);
    return record.values;
  };
  const filterOf = (entity: Entity, input: unknown) => {
    const result = validateFilter(entity, input);
    if (!result.ok) {
      throw new ActionValidationError(
        `invalid ${entity.key} filter`,
        result.errors.map((e) => ({ message: e.message })),
      );
    }
    return result.filter;
  };
  const notFound = (entity: Entity) => new ActionValidationError(`${entity.key} record not found`);
  const requireKey = (entity: Entity) => {
    if (entity.primaryKey.length === 0) {
      throw new ActionValidationError(
        `${entity.key} has no primary key, so its rows can't be addressed`,
      );
    }
  };

  const tx: ActionTx = {
    async get(table, id) {
      const entity = entityOf(table);
      const filter = addressed(entity, id);
      if (!filter) return null;
      const row = await getRow(trx, entity, filter);
      return row ? toRecordRef(entity, row) : null;
    },

    async list(table, opts = {}) {
      const entity = entityOf(table);
      const { limit = DEFAULT_TX_LIST_LIMIT } = opts;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TX_LIST_LIMIT) {
        throw new ActionValidationError(`limit must be between 1 and ${MAX_TX_LIST_LIMIT}`);
      }
      const sort = resolveSort(entity, opts.sort);
      if (!sort.ok) throw new ActionValidationError(sort.message);
      const filter = opts.filter === undefined ? undefined : filterOf(entity, opts.filter);
      const { rows } = await listRows(trx, entity, {
        sort: sort.sort,
        limit,
        ...(filter ? { filter } : {}),
      });
      return rows.map((row) => toRecordRef(entity, row));
    },

    async create(table, input) {
      const entity = entityOf(table);
      permit(entity, 'create');
      const record = values(entity, input, 'create');
      count(1);
      const row = await writing(entity, 'create', () => insertIn(trx, entity, record, { onWrite }));
      return toRecordRef(entity, row);
    },

    async update(table, target, input) {
      const entity = entityOf(table);
      permit(entity, 'update');
      requireKey(entity);
      const record = values(entity, input, 'update');
      const filter = addressed(entity, target);
      if (!filter) throw notFound(entity);
      if (Object.keys(record).length === 0) {
        const row = await lockRow(trx, entity, filter);
        if (!row) throw notFound(entity);
        return toRecordRef(entity, row);
      }
      count(1);
      const result = await writing(entity, 'update', () =>
        updateIn(trx, entity, filter, record, { onWrite }),
      );
      if (!result.ok) throw notFound(entity);
      return toRecordRef(entity, result.row);
    },

    async delete(table, target) {
      const entity = entityOf(table);
      permit(entity, 'delete');
      requireKey(entity);
      const filter = addressed(entity, target);
      if (!filter) throw notFound(entity);
      count(1);
      const result = await writing(entity, 'delete', () =>
        deleteIn(trx, entity, filter, { onWrite }),
      );
      if (!result.ok) throw notFound(entity);
    },

    async updateMany(table, filterInput, input) {
      const entity = entityOf(table);
      permit(entity, 'update');
      requireKey(entity);
      const filter = filterOf(entity, filterInput);
      const record = values(entity, input, 'update');
      // One past what's left, so going over the cap is detected before anything is written.
      const rows = await lockRows(trx, entity, filter, maxAffectedRows - affected + 1);
      if (Object.keys(record).length === 0 || rows.length === 0) return 0;
      count(rows.length);
      // Row by row through the CRUD path, so each gets its own before/after audit entry.
      for (const row of rows) {
        await writing(entity, 'update', () =>
          updateIn(trx, entity, keyFilter(entity, row), record, { onWrite }),
        );
      }
      return rows.length;
    },

    async deleteMany(table, filterInput) {
      const entity = entityOf(table);
      permit(entity, 'delete');
      requireKey(entity);
      const filter = filterOf(entity, filterInput);
      const rows = await lockRows(trx, entity, filter, maxAffectedRows - affected + 1);
      if (rows.length === 0) return 0;
      count(rows.length);
      for (const row of rows) {
        await writing(entity, 'delete', () =>
          deleteIn(trx, entity, keyFilter(entity, row), { onWrite }),
        );
      }
      return rows.length;
    },
  };

  return {
    tx: {
      get: guard(tx.get),
      list: guard(tx.list),
      create: guard(tx.create),
      update: guard(tx.update),
      delete: guard(tx.delete),
      updateMany: guard(tx.updateMany),
      deleteMany: guard(tx.deleteMany),
    },
    get failure() {
      return failure;
    },
    async close() {
      closed = true;
      const unfinished = running.size;
      await Promise.allSettled([...running]);
      return unfinished;
    },
  };
}
