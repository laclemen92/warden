import { createHash, randomBytes } from 'node:crypto';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  deleteExpiredSessions,
  deleteSession,
  deleteSessionsForSubject,
  insertSession,
  introspect,
  listSignedInUsers,
  migrate,
  MIGRATIONS,
  refreshSessionEmails,
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

  it('drops unverified emails stored on sessions before 0009', async () => {
    const verified = [true, 'true'];
    const unverified = [false, 'false', null, undefined];
    const subjects = [...verified, ...unverified].map((v, i) => ({ subject: `m${i}`, v }));
    for (const { subject, v } of subjects) {
      await insertSession(handle.db, {
        tokenHash: newHash(),
        subject,
        email: `${subject}@example.com`,
        claims: { sub: subject, ...(v === undefined ? {} : { email_verified: v }) },
      });
    }
    await sql`delete from warden.schema_migrations
              where version = '0009_session_verified_email'`.execute(handle.db);
    expect(await migrate(handle.db)).toEqual(['0009_session_verified_email']);

    const { rows } = await sql<{ subject: string; email: string | null }>`
      select subject, email from warden.sessions where subject like 'm%'
      order by subject`.execute(handle.db);
    expect(rows).toEqual(
      subjects.map(({ subject }, i) => ({
        subject,
        email: i < verified.length ? `${subject}@example.com` : null,
      })),
    );
    await sql`delete from warden.sessions where subject like 'm%'`.execute(handle.db);
  });

  it('drops ID tokens stored in plaintext before 0010', async () => {
    await insertSession(handle.db, {
      tokenHash: newHash(),
      subject: 'plain',
      claims: { sub: 'plain' },
      idToken: 'header.payload.signature',
    });
    await sql`delete from warden.schema_migrations
              where version = '0010_session_sealed_id_token'`.execute(handle.db);
    expect(await migrate(handle.db)).toEqual(['0010_session_sealed_id_token']);
    const { rows } = await sql`
      select id_token from warden.sessions where subject = 'plain'`.execute(handle.db);
    expect(rows).toEqual([{ id_token: null }]);
    await sql`delete from warden.sessions where subject = 'plain'`.execute(handle.db);
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

    expect(await deleteSession(handle.db, tokenHash)).toEqual({ idToken: null });
    expect(await touchSession(handle.db, tokenHash, TIMEOUTS)).toBeUndefined();
    expect(await deleteSession(handle.db, tokenHash)).toBeUndefined();
  });

  it("returns a deleted session's ID token, without exposing it on load", async () => {
    const tokenHash = newHash();
    await insertSession(handle.db, {
      tokenHash,
      subject: 'viewer',
      claims: {},
      idToken: 'header.payload.signature',
    });
    expect(await touchSession(handle.db, tokenHash, TIMEOUTS)).not.toHaveProperty('idToken');
    expect(await deleteSession(handle.db, tokenHash)).toEqual({
      idToken: 'header.payload.signature',
    });
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

  it('recomputes stored emails when the rule for them changes', async () => {
    await sql`delete from warden.sessions`.execute(handle.db);
    const [verified, unverified, none] = [newHash(), newHash(), newHash()];
    // Signed in under requireVerifiedEmail: false, so every email was stored.
    await insertSession(handle.db, {
      tokenHash: verified,
      subject: 'a',
      email: 'a@example.com',
      claims: { email: 'a@example.com', email_verified: true },
    });
    await insertSession(handle.db, {
      tokenHash: unverified,
      subject: 'b',
      email: 'b@example.com',
      claims: { email: 'b@example.com' },
    });
    await insertSession(handle.db, { tokenHash: none, subject: 'c', claims: {} });
    const stored = async () =>
      (await listSignedInUsers(handle.db, TIMEOUTS))
        .map((u) => [u.subject, u.email])
        .sort(([x], [y]) => String(x).localeCompare(String(y)));

    const verifiedOnly = (claims: Record<string, unknown>) =>
      claims.email_verified === true ? (claims.email as string) : undefined;
    expect(await refreshSessionEmails(handle.db, verifiedOnly)).toBe(1);
    expect(await stored()).toEqual([
      ['a', 'a@example.com'],
      ['b', null],
      ['c', null],
    ]);
    expect(await refreshSessionEmails(handle.db, verifiedOnly)).toBe(0);

    // And back again.
    const any = (claims: Record<string, unknown>) => claims.email as string | undefined;
    expect(await refreshSessionEmails(handle.db, any)).toBe(1);
    expect((await stored())[1]).toEqual(['b', 'b@example.com']);
  });

  it('lists signed-in users with their live sessions, newest details first', async () => {
    await sql`delete from warden.sessions`.execute(handle.db);
    const [older, newer, expired, other] = [newHash(), newHash(), newHash(), newHash()];
    await insertSession(handle.db, {
      tokenHash: older,
      subject: 'editor',
      email: 'old@example.com',
      claims: {},
    });
    await insertSession(handle.db, {
      tokenHash: newer,
      subject: 'editor',
      email: 'editor@example.com',
      name: 'Eddie',
      claims: {},
    });
    await insertSession(handle.db, { tokenHash: expired, subject: 'gone', claims: {} });
    await insertSession(handle.db, { tokenHash: other, subject: 'viewer', claims: {} });
    await sql`update warden.sessions set last_seen_at = now() - interval '10 minutes'
              where token_hash = ${older}`.execute(handle.db);
    await sql`update warden.sessions set last_seen_at = now() - interval '5 minutes'
              where token_hash = ${other}`.execute(handle.db);
    await sql`update warden.sessions set last_seen_at = now() - interval '2 hours'
              where token_hash = ${expired}`.execute(handle.db);

    expect(await listSignedInUsers(handle.db, TIMEOUTS)).toEqual([
      {
        subject: 'editor',
        email: 'editor@example.com',
        name: 'Eddie',
        sessions: 2,
        lastSeenAt: expect.any(String),
      },
      { subject: 'viewer', email: null, name: null, sessions: 1, lastSeenAt: expect.any(String) },
    ]);
  });

  it("deletes all of one subject's sessions and audits it", async () => {
    await sql`delete from warden.sessions`.execute(handle.db);
    const mine = [newHash(), newHash(), newHash()];
    const theirs = newHash();
    for (const tokenHash of mine) {
      await insertSession(handle.db, { tokenHash, subject: 'editor', claims: {} });
    }
    // Expired sessions go too; they would be cleaned up anyway.
    await sql`update warden.sessions set created_at = now() - interval '2 days'
              where token_hash = ${mine[2]!}`.execute(handle.db);
    await insertSession(handle.db, { tokenHash: theirs, subject: 'editor2', claims: {} });

    const actor = {
      subject: 'admin',
      email: 'admin@example.com',
      roles: ['admin'],
      requestId: 'req-1',
    };
    expect(await deleteSessionsForSubject(handle.db, { subject: 'editor', actor })).toBe(3);
    for (const tokenHash of mine) {
      expect(await touchSession(handle.db, tokenHash, TIMEOUTS)).toBeUndefined();
    }
    expect(await touchSession(handle.db, theirs, TIMEOUTS)).toBeDefined();

    // Nothing left to revoke: nothing is audited.
    expect(await deleteSessionsForSubject(handle.db, { subject: 'editor', actor })).toBe(0);
    // A subject is matched exactly, never as a pattern.
    expect(await deleteSessionsForSubject(handle.db, { subject: 'editor%', actor })).toBe(0);

    const { rows } = await sql`
      select request_id, actor_subject, actor_email, actor_roles, action, entity, primary_key,
             details, record_id, before, after
      from warden.audit_log where entity = 'warden.sessions'`.execute(handle.db);
    expect(rows).toEqual([
      {
        request_id: 'req-1',
        actor_subject: 'admin',
        actor_email: 'admin@example.com',
        actor_roles: ['admin'],
        action: 'revoke_sessions',
        entity: 'warden.sessions',
        primary_key: { subject: 'editor' },
        details: { sessions: 3 },
        record_id: null,
        before: null,
        after: null,
      },
    ]);
  });
});
