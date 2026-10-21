import { Kysely, PostgresDialect, type PostgresPool, type PostgresPoolClient } from 'kysely';
import pg from 'pg';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = Kysely<any>;

export interface DatabaseOptions {
  connectionString: string;
  /** Per-statement timeout so one expensive grid query can't tie up the database. */
  statementTimeoutMs?: number;
  /**
   * Postgres ends a session that sits in an open transaction without running anything for this
   * long, so a stalled code path can't hold a connection or a snapshot (which blocks vacuum).
   */
  idleInTransactionTimeoutMs?: number;
  maxConnections?: number;
  /** How long to wait for a free connection before failing; forever when unset. */
  connectionTimeoutMs?: number;
  /**
   * Called when an idle pooled connection errors (e.g. the database restarts). Without a handler
   * these errors would crash the process; the pool replaces the connection on next use.
   */
  onIdleError?: (err: Error) => void;
}

export interface DatabaseHandle {
  pool: pg.Pool;
  db: Database;
  /** End the pool. Safe to call more than once. */
  close(): Promise<void>;
}

// Return date/time types as Postgres' text form instead of JS Dates, which drop microseconds,
// shift timezones, and would break keyset cursors. int8 and numeric are already strings.
const TEXT_TYPES = [
  pg.types.builtins.DATE,
  pg.types.builtins.TIMESTAMP,
  pg.types.builtins.TIMESTAMPTZ,
  pg.types.builtins.TIME,
  pg.types.builtins.TIMETZ,
  pg.types.builtins.INTERVAL,
];
const typeParsers = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    TEXT_TYPES.includes(oid)
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export function createDatabase({
  connectionString,
  statementTimeoutMs = 15_000,
  idleInTransactionTimeoutMs = 60_000,
  maxConnections = 10,
  connectionTimeoutMs,
  onIdleError = (err) => console.error('idle database connection error', err),
}: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    ...(connectionTimeoutMs !== undefined ? { connectionTimeoutMillis: connectionTimeoutMs } : {}),
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: idleInTransactionTimeoutMs,
    types: typeParsers,
  });
  pool.on('error', onIdleError);
  // The pool only listens for errors on idle connections. One that is checked out and gets
  // terminated (e.g. by the idle-in-transaction timeout) would otherwise emit an unhandled
  // 'error' and crash the process; its pending or next query fails instead, and the pool discards it.
  pool.on('connect', (client) => client.on('error', () => {}));
  const db: Database = new Kysely({ dialect: new PostgresDialect({ pool }) });

  // Kysely only ends the pool if it has run a query itself, so end it directly as well.
  const close = async () => {
    await db.destroy();
    if (!pool.ended) await pool.end();
  };
  return { pool, db, close };
}

/** A transaction on a connection of its own, which can be given up without waiting for it. */
export interface DetachedTransaction {
  trx: Database;
  /** Commit, and return the connection to the pool. */
  commit(): Promise<void>;
  /** Roll back, and return the connection to the pool (or discard it if that fails). */
  rollback(): Promise<void>;
  /**
   * Close the connection now, whatever is still running on it or waiting to: Postgres rolls the
   * transaction back, pending queries fail, and the pool slot is free at once.
   */
  destroy(): void;
}

/**
 * Begin a transaction on a connection taken from `pool` for it alone. Kysely's own transactions
 * hold their connection until the callback settles, which code that never settles never does;
 * this one is let go by `destroy()`.
 */
export async function startDetachedTransaction(pool: pg.Pool): Promise<DetachedTransaction> {
  const client = await pool.connect();
  let released = false;
  const release = (discard: boolean) => {
    if (released) return;
    released = true;
    client.release(discard);
  };
  // Kysely returns its connection after the transaction; this one is released here instead.
  const single: PostgresPool = {
    connect: async () =>
      ({
        query: (...args: Parameters<pg.PoolClient['query']>) => client.query(...args),
        release: () => {},
      }) as unknown as PostgresPoolClient,
    end: async () => {},
    options: pool.options,
  };
  const db: Database = new Kysely({ dialect: new PostgresDialect({ pool: single }) });
  let trx;
  try {
    trx = await db.startTransaction().execute();
  } catch (err) {
    release(true);
    throw err;
  }
  return {
    trx,
    async commit() {
      try {
        await trx.commit().execute();
        release(false);
      } catch (err) {
        release(true);
        throw err;
      }
    },
    async rollback() {
      try {
        await trx.rollback().execute();
        release(false);
      } catch (err) {
        release(true);
        throw err;
      }
    },
    destroy: () => release(true),
  };
}
