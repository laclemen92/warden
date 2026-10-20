import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AuditEntry } from '@wardenhq/core';
import { MOCK_USERS, type MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';

type App = Awaited<ReturnType<typeof createWarden>>;

const EXAMPLE_CONFIG = readFileSync(
  fileURLToPath(new URL('../../../examples/basic/warden.config.yaml', import.meta.url)),
  'utf8',
);

// Admins by group, so an unverified email is all that tells them apart from a real one.
const IMPOSTOR = 'impostor';
const NO_EMAIL = 'no-email';
const USERS = [
  ...MOCK_USERS,
  {
    sub: IMPOSTOR,
    email: 'cfo@example.com',
    emailVerified: false,
    name: 'cfo@example.com',
    groups: ['warden-admins'],
  },
  { sub: NO_EMAIL, name: 'Nora Noemail', groups: ['warden-admins'] },
];

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: App;

const start = (config: string) =>
  createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: writeConfig(config), ...authEnv(idp) },
  });

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp({ users: USERS });
  app = await start(EXAMPLE_CONFIG);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const me = async (target: App, cookie: string) => {
  const res = await target.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ sub: string; email?: string }>();
};

/** Make an audited write (a role assignment) and return the actor it was attributed to. */
const auditedWrite = async (target: App, cookie: string) => {
  const email = `target-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await target.inject({
    method: 'POST',
    url: '/api/admin/roles/assignments',
    headers: { cookie },
    payload: { email, role: 'viewer' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const { rows } = await sqlPool.query<{ actor_subject: string; actor_email: string | null }>(
    `select actor_subject, actor_email from warden.audit_log
     where action = 'assign' and primary_key->>'email' = $1`,
    [email],
  );
  return rows[0];
};

const sessionEmails = async (subject: string) => {
  const { rows } = await sqlPool.query<{ email: string | null }>(
    `select email from warden.sessions where subject = $1`,
    [subject],
  );
  return rows.map((r) => r.email);
};

const signedIn = async (cookie: string) => {
  const res = await app.inject({ method: 'GET', url: '/api/admin/roles', headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ signedIn: { subject: string; email: string | null }[] }>().signedIn;
};

describe('actor email', () => {
  it('records a verified email on the session and its audit entries', async () => {
    const cookie = await login(app, 'admin');
    expect(await me(app, cookie)).toMatchObject({ sub: 'admin', email: 'admin@example.com' });
    expect(await sessionEmails('admin')).toContain('admin@example.com');
    expect(await auditedWrite(app, cookie)).toEqual({
      actor_subject: 'admin',
      actor_email: 'admin@example.com',
    });
  });

  it('never records an unverified email, so the user is known only by subject', async () => {
    const cookie = await login(app, IMPOSTOR);
    const user = await me(app, cookie);
    expect(user.sub).toBe(IMPOSTOR);
    expect(user).not.toHaveProperty('email');
    expect(await sessionEmails(IMPOSTOR)).toEqual([null]);
    expect(await auditedWrite(app, cookie)).toEqual({
      actor_subject: IMPOSTOR,
      actor_email: null,
    });
    expect(await signedIn(cookie)).toContainEqual(
      expect.objectContaining({ subject: IMPOSTOR, email: null }),
    );

    // Searching the audit log for the claimed address doesn't find the impostor's writes.
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit?actor=cfo',
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: AuditEntry[] }>().items).toEqual([]);
  });

  it('records no email when the IdP sends none', async () => {
    const cookie = await login(app, NO_EMAIL);
    expect(await me(app, cookie)).not.toHaveProperty('email');
    expect(await sessionEmails(NO_EMAIL)).toEqual([null]);
    expect(await auditedWrite(app, cookie)).toEqual({
      actor_subject: NO_EMAIL,
      actor_email: null,
    });
  });

  it('ignores an unverified email already stored on a session', async () => {
    const cookie = await login(app, IMPOSTOR);
    // As a session created before emails were checked would have it.
    await sqlPool.query(`update warden.sessions set email = 'cfo@example.com' where subject = $1`, [
      IMPOSTOR,
    ]);
    expect(await me(app, cookie)).not.toHaveProperty('email');
    expect(await auditedWrite(app, cookie)).toEqual({
      actor_subject: IMPOSTOR,
      actor_email: null,
    });
  });

  it('records an unverified email when access.requireVerifiedEmail is off', async () => {
    const trusting = await start(
      EXAMPLE_CONFIG.replace(/^access:\n/m, 'access:\n  requireVerifiedEmail: false\n'),
    );
    try {
      const cookie = await login(trusting, IMPOSTOR);
      expect(await me(trusting, cookie)).toMatchObject({ email: 'cfo@example.com' });
      expect(await auditedWrite(trusting, cookie)).toEqual({
        actor_subject: IMPOSTOR,
        actor_email: 'cfo@example.com',
      });
    } finally {
      await trusting.close();
    }
  });
});
