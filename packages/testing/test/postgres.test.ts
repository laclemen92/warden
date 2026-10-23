import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { SHARED_POSTGRES_ENV, startPostgres, uniqueRoleName } from '../src/index.js';

const adminUrl = () => process.env[SHARED_POSTGRES_ENV]!;

async function query<T extends pg.QueryResultRow>(url: string, text: string, values?: unknown[]) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

const databaseExists = async (connectionString: string) =>
  (
    await query(adminUrl(), 'select 1 from pg_database where datname = $1', [
      new URL(connectionString).pathname.slice(1),
    ])
  ).length === 1;

/** Check out a client the way an app does: from a pool, with no `error` listener of its own. */
async function holdClient(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  const errors: unknown[] = [];
  const onError = (err: unknown) => errors.push(err);
  // Observe without handling: with this as the only listener, an `error` would still be recorded.
  client.on('error', onError);
  return {
    client,
    errors,
    release: async () => {
      client.removeListener('error', onError);
      client.release();
      await pool.end();
    },
  };
}

describe('with the global setup', () => {
  it('shares one server', () => {
    expect(adminUrl()).toMatch(/^postgres(ql)?:\/\//);
  });

  it('gives every caller its own database, seeded with its scripts', async () => {
    const a = await startPostgres({ sql: ['create table only_in_a (id int)'] });
    const b = await startPostgres();
    try {
      expect(a.connectionString).not.toBe(b.connectionString);
      expect(await query(a.connectionString, 'select * from only_in_a')).toEqual([]);
      await expect(query(b.connectionString, 'select * from only_in_a')).rejects.toThrow(
        /does not exist/,
      );
      await b.exec('create table only_in_b (id int)');
      await expect(query(a.connectionString, 'select * from only_in_b')).rejects.toThrow(
        /does not exist/,
      );
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('drops the database on stop() once nothing is connected', async () => {
    const db = await startPostgres();
    const pool = new pg.Pool({ connectionString: db.connectionString });
    await pool.query('select 1');
    await pool.end();
    expect(await databaseExists(db.connectionString)).toBe(true);
    await db.stop();
    expect(await databaseExists(db.connectionString)).toBe(false);
  });

  it('never kills a client still checked out when stop() runs', async () => {
    const db = await startPostgres();
    const held = await holdClient(db.connectionString);
    try {
      await db.stop();
      // The connection survived: no 57P01, no error event, and it still answers.
      expect(held.errors).toEqual([]);
      expect((await held.client.query('select 1 as ok')).rows).toEqual([{ ok: 1 }]);
      expect(await databaseExists(db.connectionString)).toBe(true);
    } finally {
      await held.release();
    }
    // Once the client is gone, stopping again cleans up.
    await db.stop();
    expect(await databaseExists(db.connectionString)).toBe(false);
  }, 30_000);

  it('lets a role-creating file run twice against the same server', async () => {
    // A rerun (e.g. in watch mode) evaluates the file again, so its role names are drawn anew.
    const createRoleFromFreshRun = async () => {
      const db = await startPostgres();
      try {
        const role = uniqueRoleName('app');
        await db.exec(`create role ${role} login password 'x'`);
        return role;
      } finally {
        await db.stop();
      }
    };
    const first = await createRoleFromFreshRun();
    const second = await createRoleFromFreshRun();
    expect(first).toMatch(/^app_[0-9a-f]+$/);
    expect(second).not.toBe(first);
  });
});

describe('without the global setup', () => {
  it('refuses to start rather than starting a container per file', async () => {
    const saved = process.env[SHARED_POSTGRES_ENV];
    delete process.env[SHARED_POSTGRES_ENV];
    try {
      await expect(startPostgres()).rejects.toThrow(/global-setup/);
    } finally {
      process.env[SHARED_POSTGRES_ENV] = saved;
    }
  });
});
