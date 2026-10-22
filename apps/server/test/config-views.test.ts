import { ConfigError } from '@wardenhq/config';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SavedViewItem } from '../src/routes/saved-views.js';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';

const ROLES = `
roles:
  viewer: { grants: { users: [read] } }
  ops: { grants: { '*': [read] } }
  admin: { grants: { '*': [read] }, admin: [views] }
access:
  groups:
    warden-viewers: [viewer]
    warden-editors: [ops]
    warden-admins: [admin]
`;

const config = (sharedViews: 'both' | 'config') => `
defaults: { read: granted, sharedViews: ${sharedViews} }
tables:
  users:
    columns:
      password_hash: { hidden: true }
      last_login_at: { readableBy: [admin, ops] }
    views:
      - key: active-users
        name: Active users
        filter: { and: [{ field: is_active, op: eq, value: true }, { or: [{ field: role, op: eq, value: admin }, { field: full_name, op: isNotNull }] }] }
        sort: [{ column: email }]
        columns: [email, full_name]
        sidebar: true
        default: true
      - key: recent-logins
        name: Recent logins
        sort: [{ column: last_login_at, direction: desc }]
        sidebar: true
      - key: dropped
        name: Dropped
        columns: [email, nickname]
  orders:
    views:
      - key: paid-orders
        name: Paid orders
        filter: { field: status, op: eq, value: paid }
${ROLES}`;

type User = 'viewer' | 'editor' | 'admin';
type App = Awaited<ReturnType<typeof createWarden>>;

let db: TestDatabase;
let idp: MockOidc;
const apps = {} as Record<'both' | 'config', { app: App; cookies: Record<User, string> }>;
const logs: string[] = [];

const start = (source: string, log?: string[]) =>
  createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: writeConfig(source), ...authEnv(idp) },
    ...(log
      ? {
          logger: {
            level: 'warn',
            stream: { write: (line: string) => log.push(line) },
          },
        }
      : {}),
  });

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  idp = await startTestIdp();
  for (const mode of ['both', 'config'] as const) {
    const app = await start(config(mode), mode === 'both' ? logs : undefined);
    const cookies = {} as Record<User, string>;
    for (const user of ['viewer', 'editor', 'admin'] as const)
      cookies[user] = await login(app, user);
    apps[mode] = { app, cookies };
  }
}, 120_000);

afterAll(async () => {
  for (const { app } of Object.values(apps)) await app.close();
  await idp?.close();
  await db?.stop();
});

const send = async (
  mode: 'both' | 'config',
  user: User,
  method: string,
  url: string,
  payload?: unknown,
) => {
  const { app, cookies } = apps[mode];
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: cookies[user] },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined, raw: res.body };
};

const list = async (mode: 'both' | 'config', user: User, entity = 'users') => {
  const res = await send(mode, user, 'GET', `/api/views?entity=${entity}`);
  expect(res.status, res.raw).toBe(200);
  return (res.body as { views: SavedViewItem[] }).views;
};

const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'Not Found' };
const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };

describe('config views', () => {
  it('requires a session', async () => {
    for (const url of [
      '/api/views/sidebar',
      '/api/views/shared',
      '/api/views/config:active-users',
    ]) {
      expect((await apps.both.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('lists config views for everyone who can read the table', async () => {
    const active = {
      id: 'config:active-users',
      entity: 'users',
      name: 'Active users',
      origin: 'config',
      shared: true,
      mine: false,
      owner: null,
      canEdit: false,
      key: 'active-users',
      sidebar: true,
      default: true,
      state: {
        filter: {
          and: [
            { field: 'is_active', op: 'eq', value: true },
            {
              or: [
                { field: 'role', op: 'eq', value: 'admin' },
                { field: 'full_name', op: 'isNotNull' },
              ],
            },
          ],
        },
        sort: 'email',
        columns: ['email', 'full_name'],
      },
    };
    for (const user of ['viewer', 'editor', 'admin'] as const) {
      expect((await list('both', user))[0]).toEqual(active);
      expect(await send('both', user, 'GET', '/api/views/config:active-users')).toMatchObject({
        status: 200,
        body: active,
      });
    }
  });

  it("hides views that use a column the user can't read, as if they didn't exist", async () => {
    expect((await list('both', 'viewer')).map((v) => v.id)).not.toContain('config:recent-logins');
    expect((await list('both', 'editor')).map((v) => v.id)).toContain('config:recent-logins');
    for (const id of ['config:recent-logins', 'config:nope', 'config:dropped']) {
      expect(await send('both', 'viewer', 'GET', `/api/views/${id}`)).toEqual({
        status: 404,
        body: NOT_FOUND,
        raw: expect.any(String),
      });
    }
    // Views of tables the user can't read don't exist either.
    expect((await send('both', 'viewer', 'GET', '/api/views?entity=orders')).status).toBe(404);
    expect((await send('both', 'viewer', 'GET', '/api/views/config:paid-orders')).status).toBe(404);
    expect((await list('both', 'editor', 'orders')).map((v) => v.id)).toEqual([
      'config:paid-orders',
    ]);
  });

  it('lists sidebar views per user', async () => {
    const sidebar = async (user: User) =>
      (
        (await send('both', user, 'GET', '/api/views/sidebar')).body as { views: SavedViewItem[] }
      ).views.map((v) => v.id);
    expect(await sidebar('viewer')).toEqual(['config:active-users']);
    expect(await sidebar('editor')).toEqual(['config:active-users', 'config:recent-logins']);
  });

  it('disables a view naming a dropped column, with a warning', async () => {
    for (const user of ['viewer', 'editor', 'admin'] as const) {
      expect((await list('both', user)).map((v) => v.id)).not.toContain('config:dropped');
    }
    expect(logs.join('\n')).toContain('view \\"dropped\\" is disabled: column \\"nickname\\"');
  });

  it('refuses to change or delete config views', async () => {
    for (const user of ['viewer', 'admin'] as const) {
      for (const [method, payload] of [
        ['PATCH', { name: 'Mine now' }],
        ['PATCH', { shared: false }],
        ['DELETE', undefined],
      ] as const) {
        expect(
          await send('both', user, method, '/api/views/config:active-users', payload),
        ).toMatchObject({ status: 403, body: FORBIDDEN });
      }
    }
    // Views the user can't see 404 rather than 403.
    expect(await send('both', 'viewer', 'DELETE', '/api/views/config:recent-logins')).toMatchObject(
      { status: 404, body: NOT_FOUND },
    );
    expect((await list('both', 'viewer'))[0]!.name).toBe('Active users');
  });

  it('lets views admins list every UI-shared view for export', async () => {
    const created = await send('both', 'admin', 'POST', '/api/views', {
      entity: 'orders',
      name: 'Big orders',
      shared: true,
      state: { sort: '-total' },
    });
    expect(created.status, created.raw).toBe(201);
    const res = await send('both', 'admin', 'GET', '/api/views/shared');
    expect(res.status).toBe(200);
    expect((res.body as { views: SavedViewItem[] }).views).toEqual([
      expect.objectContaining({ name: 'Big orders', origin: 'shared', state: { sort: '-total' } }),
    ]);
    for (const user of ['viewer', 'editor'] as const) {
      expect(await send('both', user, 'GET', '/api/views/shared')).toMatchObject({
        status: 403,
        body: FORBIDDEN,
      });
    }
    await send('both', 'admin', 'DELETE', `/api/views/${(created.body as SavedViewItem).id}`);
  });
});

describe('defaults.sharedViews: config', () => {
  it('refuses sharing in the UI with the same 403 as without the permission', async () => {
    const refused = await send('config', 'admin', 'POST', '/api/views', {
      entity: 'users',
      name: 'Shared',
      shared: true,
      state: {},
    });
    const unprivileged = await send('config', 'viewer', 'POST', '/api/views', {
      entity: 'users',
      name: 'Shared',
      shared: true,
      state: {},
    });
    expect(refused).toEqual({ ...unprivileged, raw: expect.any(String) });
    expect(refused).toMatchObject({ status: 403, body: FORBIDDEN });

    const own = await send('config', 'admin', 'POST', '/api/views', {
      entity: 'users',
      name: 'Still personal',
      state: { sort: 'email' },
    });
    expect(own).toMatchObject({ status: 201, body: { origin: 'personal', canEdit: true } });
    const id = (own.body as SavedViewItem).id;
    expect(
      await send('config', 'admin', 'PATCH', `/api/views/${id}`, { shared: true }),
    ).toMatchObject({ status: 403, body: FORBIDDEN });
    expect(await send('config', 'admin', 'DELETE', `/api/views/${id}`)).toMatchObject({
      status: 204,
    });
  });

  it('hides UI-shared views from everyone but their owner and views admins', async () => {
    // Shared before the switch to config mode.
    const legacy = await send('both', 'admin', 'POST', '/api/views', {
      entity: 'users',
      name: 'Legacy team view',
      shared: true,
      state: { sort: '-created_at' },
    });
    expect(legacy.status, legacy.raw).toBe(201);
    const id = (legacy.body as SavedViewItem).id;

    for (const user of ['viewer', 'editor'] as const) {
      expect((await list('config', user)).map((v) => v.name)).not.toContain('Legacy team view');
      expect(await send('config', user, 'GET', `/api/views/${id}`)).toMatchObject({
        status: 404,
        body: NOT_FOUND,
      });
    }
    const flagged = (await list('config', 'admin')).find((v) => v.id === id);
    expect(flagged).toMatchObject({
      origin: 'shared',
      notInConfig: true,
      canEdit: false,
      state: { sort: '-created_at' },
    });
    expect((await list('config', 'admin'))[0]!.id).toBe('config:active-users');
    expect(
      await send('config', 'admin', 'PATCH', `/api/views/${id}`, { name: 'Edited' }),
    ).toMatchObject({ status: 403 });
    expect(await send('config', 'admin', 'DELETE', `/api/views/${id}`)).toMatchObject({
      status: 204,
    });
  });
});

describe('startup', () => {
  const fails = async (views: string, columns = '') => {
    const err = await start(`
tables:
  users:
    columns: { password_hash: { hidden: true }${columns} }
    views:
${views}
${ROLES}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  };

  it('fails on a view using a hidden column, naming the file and line', async () => {
    const err = await fails(`      - key: a
        name: A
        columns: [email, password_hash]`);
    expect(err.file).toMatch(/warden\.config\.yaml$/);
    expect(err.issues).toEqual([
      {
        path: 'tables.users.views.0.columns.1',
        message: 'column "password_hash" is hidden and cannot be used in a view',
        line: 8,
        column: 26,
      },
    ]);
  });

  it('fails on invalid filters and sorts', async () => {
    const filter = await fails(`      - key: a
        name: A
        filter: { field: email, op: gt, value: [1] }`);
    expect(filter.issues).toEqual([
      expect.objectContaining({ path: expect.stringMatching(/^tables\.users\.views\.0\.filter/) }),
    ]);
    expect(filter.issues[0]!.line).toBe(8);
    const sort = await fails(`      - key: a
        name: A
        sort: [{ column: metadata }]`);
    expect(sort.issues).toEqual([
      expect.objectContaining({ path: 'tables.users.views.0.sort', line: 8 }),
    ]);
  });
});
