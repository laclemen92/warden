import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/index.js';

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

  it('can be closed more than once', async () => {
    const extra = createDatabase({ connectionString: pgContainer.connectionString });
    await extra.close();
    await expect(extra.close()).resolves.toBeUndefined();
  });
});
