import { fileURLToPath } from 'node:url';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, beginLogin, callback, login, signInAtIdp, startTestIdp } from './helpers/auth.js';

type App = Awaited<ReturnType<typeof createWarden>>;

const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
);
const ROLES = '/api/admin/roles';
const ASSIGNMENTS = '/api/admin/roles/assignments';

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: App;
let admin: string;
let viewer: string;
let editor: string;

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: EXAMPLE_CONFIG, ...authEnv(idp) },
  });
  admin = await login(app, 'admin');
  viewer = await login(app, 'viewer');
  editor = await login(app, 'editor');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const assign = (payload: unknown, cookie = admin) =>
  app.inject({ method: 'POST', url: ASSIGNMENTS, headers: { cookie }, payload: payload as object });
const unassign = (payload: unknown, cookie = admin) =>
  app.inject({
    method: 'DELETE',
    url: ASSIGNMENTS,
    headers: { cookie },
    payload: payload as object,
  });
const me = async (cookie: string) =>
  (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json<{
    roles: string[];
    admin: string[];
  }>();

/** The outcome of a full login as `sub`: the redirect Warden sends the browser to. */
async function tryLogin(sub: string) {
  const { authorizeUrl, cookies } = await beginLogin(app);
  const res = await callback(app, await signInAtIdp(authorizeUrl, sub), cookies);
  return String(res.headers.location);
}

describe('roles page API', () => {
  it('lists config roles and access rules read-only, with assignments', async () => {
    const res = await app.inject({ method: 'GET', url: ROLES, headers: { cookie: admin } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      roles: [
        { name: 'viewer', grants: { '*': ['read'] }, admin: [] },
        {
          name: 'admin',
          grants: { '*': ['read', 'create', 'update', 'delete', 'export'] },
          admin: ['schema', 'audit', 'roles', 'views'],
        },
        {
          name: 'ops',
          grants: {
            users: ['read', 'update'],
            companies: ['read', 'create', 'update'],
            orders: ['update'],
          },
          admin: [],
        },
      ],
      access: {
        groups: {
          'warden-viewers': ['viewer'],
          'warden-editors': ['ops'],
          'warden-admins': ['admin'],
        },
        emailDomains: { 'example.com': ['viewer'] },
        allowAll: false,
      },
      assignments: [],
    });
    expect(await me(admin)).toMatchObject({ admin: ['schema', 'audit', 'roles', 'views'] });
  });

  it('adds an assigned role to existing sessions right away, and removes it again', async () => {
    expect((await me(viewer)).roles).toEqual(['viewer']);

    const res = await assign({ email: ' Viewer@Example.com ', role: 'ops' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      email: 'viewer@example.com',
      role: 'ops',
      assignedBy: 'admin',
      defined: true,
    });
    expect((await me(viewer)).roles).toEqual(['ops', 'viewer']);
    // The new role's grants apply too: ops may update users.
    const caps = async () =>
      (
        await app.inject({ method: 'GET', url: '/api/capabilities', headers: { cookie: viewer } })
      ).json<{ entities: Record<string, { actions: string[] }> }>().entities.users?.actions;
    expect(await caps()).toEqual(['read', 'update']);

    expect((await assign({ email: 'viewer@example.com', role: 'ops' })).statusCode).toBe(409);

    const removed = await unassign({ email: 'VIEWER@example.com', role: 'ops' });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await me(viewer)).roles).toEqual(['viewer']);
    expect(await caps()).toEqual(['read']);
    expect((await unassign({ email: 'viewer@example.com', role: 'ops' })).statusCode).toBe(404);
  });

  it('audits every assignment change', async () => {
    const { rows } = await sqlPool.query(
      `select actor_subject, actor_email, actor_roles, action, primary_key, request_id
       from warden.audit_log where entity = 'warden.role_assignments' order by id`,
    );
    const entry = {
      actor_subject: 'admin',
      actor_email: 'admin@example.com',
      actor_roles: ['admin', 'viewer'],
      primary_key: { email: 'viewer@example.com', role: 'ops' },
      request_id: expect.any(String),
    };
    expect(rows).toEqual([
      { ...entry, action: 'assign' },
      { ...entry, action: 'unassign' },
    ]);
  });

  it('lets a user that no access rule matches sign in once assigned a role', async () => {
    expect(await tryLogin('outsider')).toBe('/login?error=access_denied');

    expect((await assign({ email: 'outsider@example.org', role: 'viewer' })).statusCode).toBe(201);
    expect(await tryLogin('outsider')).toBe('/');
    const outsider = await login(app, 'outsider');
    expect(await me(outsider)).toMatchObject({ roles: ['viewer'], admin: [] });

    // Removing the only role ends their access on the next request.
    expect((await unassign({ email: 'outsider@example.org', role: 'viewer' })).statusCode).toBe(
      204,
    );
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: outsider } });
    expect(res.statusCode).toBe(401);
    expect(await tryLogin('outsider')).toBe('/login?error=access_denied');
  });

  it('ignores assignments of roles config no longer defines, but can remove them', async () => {
    await sqlPool.query(
      `insert into warden.role_assignments (email, role, assigned_by)
       values ('editor@example.com', 'ghost', 'someone')`,
    );
    expect((await me(editor)).roles).toEqual(['ops', 'viewer']);
    const list = await app.inject({ method: 'GET', url: ROLES, headers: { cookie: admin } });
    expect(list.json<{ assignments: unknown[] }>().assignments).toEqual([
      expect.objectContaining({ email: 'editor@example.com', role: 'ghost', defined: false }),
    ]);
    expect((await unassign({ email: 'editor@example.com', role: 'ghost' })).statusCode).toBe(204);
  });

  it('rejects invalid assignments without changing anything', async () => {
    for (const [payload, message] of [
      [{ email: 'not-an-email', role: 'ops' }, 'email must be an email address'],
      [{ email: 'a@example.com', role: 'ghost' }, 'role "ghost" is not defined in config'],
      [{ email: 'a@example.com', role: 'constructor' }, 'role "constructor" is not defined'],
      [{ email: 'a@example.com', role: '__proto__' }, 'role "__proto__" is not defined'],
      [{ email: 'a@example.com' }, "must have required property 'role'"],
      [{ email: `${'a'.repeat(250)}@example.com`, role: 'ops' }, ''],
    ] as const) {
      const res = await assign(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json<{ message: string }>().message).toContain(message);
    }
    const { rows } = await sqlPool.query(`select count(*)::int as n from warden.role_assignments`);
    expect(rows[0].n).toBe(0);
  });

  it('is indistinguishable from a missing route for users without admin: [roles]', async () => {
    const missing = async (method: 'GET' | 'POST' | 'DELETE') => {
      const res = await app.inject({ method, url: '/api/admin/nope', headers: { cookie: viewer } });
      expect(res.statusCode).toBe(404);
      return normalize(res.body);
    };
    const normalize = (body: string) => body.replaceAll(/\/api\/admin\/[\w/-]+/g, '<url>');

    for (const cookie of [viewer, editor]) {
      const get = await app.inject({ method: 'GET', url: ROLES, headers: { cookie } });
      expect(get.statusCode).toBe(404);
      expect(normalize(get.body)).toBe(await missing('GET'));

      for (const method of ['POST', 'DELETE'] as const) {
        for (const payload of [
          '{"email":"editor@example.com","role":"admin"}',
          '{not json',
          '{"role":1}',
        ]) {
          const res = await app.inject({
            method,
            url: ASSIGNMENTS,
            headers: { cookie, 'content-type': 'application/json' },
            payload,
          });
          expect(res.statusCode).toBe(404);
          expect(normalize(res.body)).toBe(await missing(method));
        }
      }
    }
    expect((await me(editor)).roles).toEqual(['ops', 'viewer']);
    const { rows } = await sqlPool.query(
      `select count(*)::int as n from warden.audit_log where entity = 'warden.role_assignments'`,
    );
    // Only the admin's changes in the tests above.
    expect(rows[0].n).toBe(5);
  });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: ROLES })).statusCode).toBe(401);
    expect((await assign({ email: 'a@example.com', role: 'ops' }, '')).statusCode).toBe(401);
    expect((await unassign({ email: 'a@example.com', role: 'ops' }, '')).statusCode).toBe(401);
  });
});
