import { createHash, randomBytes } from 'node:crypto';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  deleteExpiredSessions,
  deleteSession,
  insertSession,
  introspect,
  migrate,
  MIGRATIONS,
  touchSession,
  type DatabaseHandle,
} from '../src/index.js';

let pgContainer: TestDatabase;
let handle: DatabaseHandle;

const TIMEOUTS = { idleSeconds: 3600, absoluteSeconds: 86_400 };
const newHash = () => createHash('sha256').update(randomBytes(32)).digest();

beforeAll(async () => {
  pgContainer = await startPostgres({ sql: ['create table widgets (id int primary key)'] });
  handle = createDatabase({ connectionString: pgContainer.connectionString });
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

describe('migrate', () => {
  it('applies every migration once, even when run concurrently', async () => {
    const runs = await Promise.all([migrate(handle.db), migrate(handle.db), migrate(handle.db)]);
    expect(runs.flat().sort()).toEqual(MIGRATIONS.map((m) => m.version));

    expect(await migrate(handle.db)).toEqual([]);
    const { rows } = await sql<{ version: string }>`
      select version from warden.schema_migrations order by version`.execute(handle.db);
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('rolls back a failing batch entirely', async () => {
    const broken = [
      ...MIGRATIONS,
      { version: '9998_ok', sql: 'create table warden.should_not_exist (id int)' },
      { version: '9999_broken', sql: 'select * from nope' },
    ];
    await expect(migrate(handle.db, broken)).rejects.toThrow();
    const { rows } = await sql`
      select 1 from warden.schema_migrations where version like '999%'
      union all select 1 from pg_tables where tablename = 'should_not_exist'`.execute(handle.db);
    expect(rows).toEqual([]);
  });

  it("keeps Warden's own tables out of introspection", async () => {
    const model = await introspect(handle.pool, { schemas: ['public', 'warden'] });
    expect(model.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(['public.widgets']);
  });
});

describe('sessions', () => {
  it('stores, touches, and deletes a session', async () => {
    const tokenHash = newHash();
    await insertSession(handle.db, {
      tokenHash,
      subject: 'editor',
      email: 'editor@example.com',
      claims: { groups: ['warden-editors'] },
    });
    const session = await touchSession(handle.db, tokenHash, TIMEOUTS);
    expect(session).toMatchObject({
      subject: 'editor',
      email: 'editor@example.com',
      name: null,
      claims: { groups: ['warden-editors'] },
    });

    await deleteSession(handle.db, tokenHash);
    expect(await touchSession(handle.db, tokenHash, TIMEOUTS)).toBeUndefined();
  });

  it('returns nothing for an unknown token', async () => {
    expect(await touchSession(handle.db, newHash(), TIMEOUTS)).toBeUndefined();
  });

  it('expires idle sessions and refreshes active ones', async () => {
    const idle = newHash();
    const active = newHash();
    for (const tokenHash of [idle, active]) {
      await insertSession(handle.db, { tokenHash, subject: 'viewer', claims: {} });
    }
    await sql`update warden.sessions set last_seen_at = now() - interval '2 hours'
              where token_hash = ${idle}`.execute(handle.db);
    await sql`update warden.sessions set last_seen_at = now() - interval '59 minutes'
              where token_hash = ${active}`.execute(handle.db);

    expect(await touchSession(handle.db, idle, TIMEOUTS)).toBeUndefined();
    expect(await touchSession(handle.db, active, TIMEOUTS)).toBeDefined();
    // Touching reset the idle clock.
    const { rows } = await sql<{ fresh: boolean }>`
      select last_seen_at > now() - interval '1 minute' as fresh
      from warden.sessions where token_hash = ${active}`.execute(handle.db);
    expect(rows[0]?.fresh).toBe(true);
  });

  it('expires sessions past the absolute timeout even when active', async () => {
    const tokenHash = newHash();
    await insertSession(handle.db, { tokenHash, subject: 'admin', claims: {} });
    await sql`update warden.sessions set created_at = now() - interval '25 hours'
              where token_hash = ${tokenHash}`.execute(handle.db);
    expect(await touchSession(handle.db, tokenHash, TIMEOUTS)).toBeUndefined();
  });

  it('deletes only expired sessions', async () => {
    await sql`delete from warden.sessions`.execute(handle.db);
    const keep = newHash();
    const stale = newHash();
    const old = newHash();
    for (const tokenHash of [keep, stale, old]) {
      await insertSession(handle.db, { tokenHash, subject: 'viewer', claims: {} });
    }
    await sql`update warden.sessions set last_seen_at = now() - interval '2 hours'
              where token_hash = ${stale}`.execute(handle.db);
    await sql`update warden.sessions set created_at = now() - interval '2 days'
              where token_hash = ${old}`.execute(handle.db);

    expect(await deleteExpiredSessions(handle.db, TIMEOUTS)).toBe(2);
    expect(await touchSession(handle.db, keep, TIMEOUTS)).toBeDefined();
  });
});
