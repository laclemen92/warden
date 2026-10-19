import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = Kysely<any>;

export interface DatabaseOptions {
  connectionString: string;
  /** Per-statement timeout so one expensive grid query can't tie up the database. */
  statementTimeoutMs?: number;
  maxConnections?: number;
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
  maxConnections = 10,
  onIdleError = (err) => console.error('idle database connection error', err),
}: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    statement_timeout: statementTimeoutMs,
    types: typeParsers,
  });
  pool.on('error', onIdleError);
  const db: Database = new Kysely({ dialect: new PostgresDialect({ pool }) });

  // Kysely only ends the pool if it has run a query itself, so end it directly as well.
  const close = async () => {
    await db.destroy();
    if (!pool.ended) await pool.end();
  };
  return { pool, db, close };
}
