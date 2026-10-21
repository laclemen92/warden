import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, startDetachedTransaction, type DatabaseHandle } from '../src/index.js';

let pgContainer: TestDatabase;
let handle: DatabaseHandle;
const idleErrors: Error[] = [];

beforeAll(async () => {
  pgContainer = await startPostgres();
  handle = createDatabase({
    connectionString: pgContainer.connectionString,
    statementTimeoutMs: 200,
    onIdleError: (err) => idleErrors.push(err),
  });
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

describe('createDatabase', () => {
  it('returns date/time values as Postgres text, keeping microseconds', async () => {
    const { rows } = await sql<Record<string, unknown>>`
      select timestamptz '2026-01-02 03:04:05.123456+00' as ts,
             date '2026-01-02' as d,
             9223372036854775807::int8 as big,
             1.10::numeric(5,2) as num`.execute(handle.db);
    expect(rows[0]).toEqual({
      ts: '2026-01-02 03:04:05.123456+00',
      d: '2026-01-02',
      big: '9223372036854775807',
      num: '1.10',
    });
  });

  it('enforces the statement timeout', async () => {
    await expect(sql`select pg_sleep(2)`.execute(handle.db)).rejects.toThrow(/statement timeout/);
  });

  it('survives the database dropping idle connections', async () => {
    await sql`select 1`.execute(handle.db);
    await pgContainer.exec(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where pid <> pg_backend_pid() and datname = current_database()`,
    );
    await expect.poll(() => idleErrors.length).toBeGreaterThan(0);
    const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(handle.db);
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it('ends transactions left idle, without crashing on the checked-out connection', async () => {
    const short = createDatabase({
      connectionString: pgContainer.connectionString,
      idleInTransactionTimeoutMs: 200,
      maxConnections: 1,
    });
    try {
      const trx = await short.db.startTransaction().execute();
      await sql`select 1`.execute(trx);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(sql`select 1`.execute(trx)).rejects.toThrow();
      await trx
        .rollback()
        .execute()
        .catch(() => {});
      // The pool discards the dead connection and opens a new one.
      const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(short.db);
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await short.close();
    }
  });

  it('can be closed more than once', async () => {
    const extra = createDatabase({ connectionString: pgContainer.connectionString });
    await extra.close();
    await expect(extra.close()).resolves.toBeUndefined();
  });
});

describe('startDetachedTransaction', () => {
  const single = () =>
    createDatabase({
      connectionString: pgContainer.connectionString,
      maxConnections: 1,
      connectionTimeoutMs: 2000,
    });
  const count = async (db: DatabaseHandle['db']) =>
    (await sql<{ n: string }>`select count(*) as n from detached`.execute(db)).rows[0]!.n;

  beforeAll(async () => {
    await sql`create table if not exists detached (v int)`.execute(handle.db);
  });

  it('commits and rolls back like a transaction, returning its connection', async () => {
    const pool = single();
    try {
      const kept = await startDetachedTransaction(pool.pool);
      await sql`insert into detached values (1)`.execute(kept.trx);
      await kept.commit();
      const undone = await startDetachedTransaction(pool.pool);
      await sql`insert into detached values (2)`.execute(undone.trx);
      await undone.rollback();
      expect(await count(pool.db)).toBe('1');
      expect(pool.pool.idleCount).toBe(1);
    } finally {
      await sql`truncate detached`.execute(handle.db);
      await pool.close();
    }
  });

  it('frees the pool slot at once on destroy, rolling back and failing what is pending', async () => {
    const pool = single();
    try {
      const abandoned = await startDetachedTransaction(pool.pool);
      await sql`insert into detached values (3)`.execute(abandoned.trx);
      const pending = sql`select pg_sleep(1)`.execute(abandoned.trx);
      abandoned.destroy();
      await expect(pending).rejects.toThrow();
      // The only connection is free again without waiting for anything.
      expect(await count(pool.db)).toBe('0');
      await expect(sql`select 1`.execute(abandoned.trx)).rejects.toThrow();
      abandoned.destroy();
    } finally {
      await pool.close();
    }
  });
});
