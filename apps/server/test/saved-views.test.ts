import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SavedViewItem } from '../src/routes/saved-views.js';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

const CONFIG = `
defaults:
  read: granted
tables:
  users:
    columns:
      password_hash: { hidden: true }
      last_login_at: { readableBy: [admin, ops] }
      metadata: { readableBy: [ops] }
  internal_notes:
    hidden: true
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

type User = 'viewer' | 'editor' | 'admin';

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
const cookies = {} as Record<User, string>;

beforeAll(async () => {
  db = await startPostgres({
    sql: [
      await readExampleSql('basic/schema.sql'),
      await readExampleSql('basic/seed.sql'),
      'create table internal_notes (id int primary key, body text)',
    ],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  const dir = mkdtempSync(join(tmpdir(), 'warden-views-'));
  const config = join(dir, 'warden.config.yaml');
  writeFileSync(config, CONFIG);
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: config, ...authEnv(idp) },
  });
  for (const user of ['viewer', 'editor', 'admin'] as const) {
    cookies[user] = await login(app, user);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const send = async (user: User, method: string, url: string, payload?: unknown) => {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: cookies[user] },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined, raw: res.body };
};

const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'Not Found' };

async function create(user: User, body: Record<string, unknown>): Promise<SavedViewItem> {
  const res = await send(user, 'POST', '/api/views', { entity: 'users', state: {}, ...body });
  expect(res.status, res.raw).toBe(201);
  return res.body as SavedViewItem;
}

const names = async (user: User, entity = 'users') => {
  const res = await send(user, 'GET', `/api/views?entity=${entity}`);
  expect(res.status, res.raw).toBe(200);
  return (res.body as { views: SavedViewItem[] }).views.map((v) => v.name);
};

describe('saved views', () => {
  it('requires a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/views?entity=users'],
      ['POST', '/api/views'],
      ['GET', '/api/views/1'],
      ['PATCH', '/api/views/1'],
      ['DELETE', '/api/views/1'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
  });

  it('saves a private view only its owner can see', async () => {
    const state = {
      filter: { field: 'is_active', op: 'eq', value: true },
      q: 'example',
      sort: '-created_at',
      columns: ['email', 'full_name'],
    };
    const view = await create('viewer', { name: '  Active users ', state });
    expect(view).toEqual({
      id: expect.stringMatching(/^\d+$/),
      entity: 'users',
      name: 'Active users',
      shared: false,
      mine: true,
      owner: 'Vera Viewer',
      canEdit: true,
      state,
      updatedAt: expect.any(String),
    });
    expect(await send('viewer', 'GET', `/api/views/${view.id}`)).toMatchObject({
      status: 200,
      body: view,
    });
    expect(await names('viewer')).toContain('Active users');

    // To everyone else, including users who may share views, it doesn't exist.
    for (const user of ['editor', 'admin'] as const) {
      expect(await names(user)).not.toContain('Active users');
      for (const method of ['GET', 'DELETE'])
        expect(await send(user, method, `/api/views/${view.id}`)).toMatchObject({
          status: 404,
          body: NOT_FOUND,
        });
      expect(
        await send(user, 'PATCH', `/api/views/${view.id}`, { name: 'Taken over' }),
      ).toMatchObject({ status: 404, body: NOT_FOUND });
    }
  });

  it('lets owners rename, update, and delete their views', async () => {
    const view = await create('editor', { name: 'Mine' });
    const updated = await send('editor', 'PATCH', `/api/views/${view.id}`, {
      name: 'Renamed',
      state: { sort: 'email' },
    });
    expect(updated).toMatchObject({
      status: 200,
      body: { id: view.id, name: 'Renamed', state: { sort: 'email' } },
    });
    expect((await send('editor', 'DELETE', `/api/views/${view.id}`)).status).toBe(204);
    expect((await send('editor', 'GET', `/api/views/${view.id}`)).status).toBe(404);
  });

  it('keeps names unique per user and entity', async () => {
    await create('editor', { name: 'Duplicate' });
    expect(
      await send('editor', 'POST', '/api/views', { entity: 'users', name: 'duplicate', state: {} }),
    ).toMatchObject({
      status: 409,
      body: { message: 'you already have a view with this name' },
    });
    await create('viewer', { name: 'Duplicate' });
  });

  it('requires admin: [views] to share a view', async () => {
    const before = await sqlPool.query('select count(*)::int as n from warden.saved_views');
    for (const user of ['viewer', 'editor'] as const) {
      expect(
        await send(user, 'POST', '/api/views', {
          entity: 'users',
          name: 'Everyone',
          shared: true,
          state: {},
        }),
      ).toMatchObject({ status: 403 });
    }
    const after = await sqlPool.query('select count(*)::int as n from warden.saved_views');
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const own = await create('viewer', { name: 'Try to share' });
    expect(await send('viewer', 'PATCH', `/api/views/${own.id}`, { shared: true })).toMatchObject({
      status: 403,
    });
    expect((await send('viewer', 'GET', `/api/views/${own.id}`)).body).toMatchObject({
      shared: false,
    });
  });

  it('shows shared views to everyone who can read the entity, editable only with the permission', async () => {
    const view = await create('admin', {
      name: 'Team view',
      shared: true,
      state: { sort: 'email' },
    });
    expect(view).toMatchObject({ shared: true, mine: true, canEdit: true, owner: 'Ada Admin' });

    for (const user of ['viewer', 'editor'] as const) {
      expect(await names(user)).toContain('Team view');
      expect((await send(user, 'GET', `/api/views/${view.id}`)).body).toMatchObject({
        mine: false,
        canEdit: false,
        state: { sort: 'email' },
      });
      expect(
        await send(user, 'PATCH', `/api/views/${view.id}`, { state: { sort: '-email' } }),
      ).toMatchObject({ status: 403 });
      expect(await send(user, 'DELETE', `/api/views/${view.id}`)).toMatchObject({ status: 403 });
    }
    expect((await send('admin', 'GET', `/api/views/${view.id}`)).body).toMatchObject({
      state: { sort: 'email' },
    });
  });

  it("lets anyone with the permission manage others' shared views, and owners delete theirs", async () => {
    // Shared directly, as if the owner had lost the permission since.
    const { rows } = await sqlPool.query<{ id: string }>(
      `insert into warden.saved_views (entity, name, owner_subject, shared, state)
       values ('users', 'Legacy', 'editor', true, '{}') returning id::text`,
    );
    const id = rows[0]!.id;
    expect((await send('editor', 'GET', `/api/views/${id}`)).body).toMatchObject({
      mine: true,
      canEdit: false,
    });
    expect(await send('editor', 'PATCH', `/api/views/${id}`, { name: 'Mine now' })).toMatchObject({
      status: 403,
    });
    expect(await send('admin', 'PATCH', `/api/views/${id}`, { name: 'Curated' })).toMatchObject({
      status: 200,
      body: { name: 'Curated', mine: false, canEdit: true },
    });
    expect((await send('editor', 'DELETE', `/api/views/${id}`)).status).toBe(204);
  });

  it('rejects views that name hidden or unreadable fields exactly like nonexistent ones', async () => {
    const errorFor = async (user: User, column: string) => {
      const res = await send(user, 'POST', '/api/views', {
        entity: 'users',
        name: `Uses ${column}`,
        state: { sort: column, columns: [column], filter: { field: column, op: 'isNull' } },
      });
      expect(res.status, res.raw).toBe(400);
      return res.raw.replaceAll(column, '<field>');
    };
    const missing = await errorFor('viewer', 'no_such_column');
    expect(await errorFor('viewer', 'password_hash')).toBe(missing);
    expect(await errorFor('viewer', 'last_login_at')).toBe(missing);
    expect(await errorFor('admin', 'password_hash')).toBe(missing);
    await create('editor', { name: 'Logins', state: { sort: 'last_login_at' } });
  });

  it("hides shared views that name a field the user can't see", async () => {
    const view = await create('admin', {
      name: 'Recent logins',
      shared: true,
      state: { sort: '-last_login_at', columns: ['email', 'last_login_at'] },
    });
    expect(await names('editor')).toContain('Recent logins');
    expect(await names('viewer')).not.toContain('Recent logins');
    expect(await send('viewer', 'GET', `/api/views/${view.id}`)).toMatchObject({
      status: 404,
      body: NOT_FOUND,
    });
    expect((await send('viewer', 'GET', '/api/views?entity=users')).raw).not.toContain(
      'last_login_at',
    );
  });

  it('shows out-of-date views without their state to those who may delete them', async () => {
    // As if the column had been hidden after the view was saved.
    const { rows } = await sqlPool.query<{ id: string }>(
      `insert into warden.saved_views (entity, name, owner_subject, shared, state)
       values ('users', 'Stale', 'viewer', true, '{"columns": ["password_hash"]}')
       returning id::text`,
    );
    const id = rows[0]!.id;
    const stale = await send('viewer', 'GET', `/api/views/${id}`);
    expect(stale).toMatchObject({ status: 200, body: { name: 'Stale', state: null } });
    expect(stale.raw).not.toContain('password_hash');
    expect((await send('admin', 'GET', `/api/views/${id}`)).body).toMatchObject({ state: null });
    expect((await send('editor', 'GET', `/api/views/${id}`)).status).toBe(404);
    expect(await names('editor')).not.toContain('Stale');

    // Saving a valid state brings it back for everyone.
    expect(
      await send('admin', 'PATCH', `/api/views/${id}`, { state: { columns: ['email'] } }),
    ).toMatchObject({ status: 200, body: { state: { columns: ['email'] } } });
    expect(await names('editor')).toContain('Stale');
  });

  it("hides shared views that name a restricted field from views admins who can't read it", async () => {
    // Saved by someone who can read metadata, and shared by a views admin who can too.
    const insert = async (name: string, state: unknown) => {
      const { rows } = await sqlPool.query<{ id: string }>(
        `insert into warden.saved_views (entity, name, owner_subject, owner_name, shared, state)
         values ('users', $1, 'editor', 'Eddie Editor', true, $2) returning id::text`,
        [name, JSON.stringify(state)],
      );
      return rows[0]!.id;
    };
    const restricted = await insert('VIP metadata', {
      filter: { not: { field: 'metadata', op: 'isNull' } },
      columns: ['email'],
    });
    // A missing field must not make it look merely out of date.
    const mixed = await insert('VIP metadata, stale', { columns: ['metadata', 'dropped'] });
    const stale = await insert('Plain stale', { columns: ['dropped'] });

    for (const id of [restricted, mixed]) {
      for (const user of ['admin', 'viewer'] as const) {
        for (const [method, payload] of [
          ['GET', undefined],
          ['PATCH', { name: 'Renamed' }],
          ['DELETE', undefined],
        ] as const) {
          expect(await send(user, method, `/api/views/${id}`, payload)).toMatchObject({
            status: 404,
            body: NOT_FOUND,
          });
        }
      }
    }
    for (const user of ['admin', 'viewer'] as const) {
      const res = await send(user, 'GET', '/api/views?entity=users');
      expect(res.raw).not.toContain('VIP metadata');
      expect(res.raw).not.toContain('metadata');
    }
    // A view that is out of date for everyone reveals nothing, so views admins can still clean
    // it up.
    expect(await send('admin', 'GET', `/api/views/${stale}`)).toMatchObject({
      status: 200,
      body: { name: 'Plain stale', state: null, canEdit: true },
    });
    expect(await names('viewer')).not.toContain('Plain stale');

    // Its owner, who can read the field, still sees and manages it.
    expect(await send('editor', 'GET', `/api/views/${restricted}`)).toMatchObject({
      status: 200,
      body: { name: 'VIP metadata', mine: true, state: { columns: ['email'] } },
    });
    expect(await names('editor')).toEqual(
      expect.arrayContaining(['VIP metadata', 'VIP metadata, stale', 'Plain stale']),
    );
    for (const id of [restricted, mixed, stale]) {
      expect((await send('editor', 'DELETE', `/api/views/${id}`)).status).toBe(204);
    }
  });

  it('treats unreadable, hidden, and missing entities the same', async () => {
    const missing = await send('viewer', 'GET', '/api/views?entity=nope');
    expect(missing).toMatchObject({ status: 404, body: NOT_FOUND });
    for (const entity of ['orders', 'internal_notes']) {
      expect(await send('viewer', 'GET', `/api/views?entity=${entity}`)).toEqual(missing);
      expect(
        await send('viewer', 'POST', '/api/views', { entity, name: 'x', state: {} }),
      ).toMatchObject({ status: 404, body: NOT_FOUND });
    }
    expect(await names('editor', 'orders')).toEqual([]);

    // A view of an entity the user can no longer read doesn't exist for them.
    const view = await create('editor', { entity: 'orders', name: 'Orders view', shared: false });
    await sqlPool.query(`update warden.saved_views set owner_subject = 'viewer' where id = $1`, [
      view.id,
    ]);
    expect(await send('viewer', 'GET', `/api/views/${view.id}`)).toEqual(missing);
    expect(await send('viewer', 'DELETE', `/api/views/${view.id}`)).toEqual(missing);
  });

  it('404s malformed ids and rejects malformed bodies', async () => {
    for (const id of ['0', 'abc', '1;drop', '99999999999999999999', '-1', '999999']) {
      expect(await send('viewer', 'GET', `/api/views/${encodeURIComponent(id)}`)).toMatchObject({
        status: 404,
        body: NOT_FOUND,
      });
    }
    for (const body of [
      {},
      { entity: 'users', name: '', state: {} },
      { entity: 'users', name: '   ', state: {} },
      { entity: 'users', name: 'x'.repeat(101), state: {} },
      { entity: 'users', name: 'x', state: { pageSize: 10 } },
      { entity: 'users', name: 'x', state: 'sort=id' },
      {
        entity: 'users',
        name: 'x',
        state: { filter: { field: 'email', op: 'eq', value: { $ne: 1 } } },
      },
    ]) {
      expect((await send('viewer', 'POST', '/api/views', body)).status, JSON.stringify(body)).toBe(
        400,
      );
    }
    const view = await create('viewer', { name: 'Patch me' });
    expect((await send('viewer', 'PATCH', `/api/views/${view.id}`, {})).status).toBe(400);

    // Ownership comes from the session, never the body.
    const forged = await create('viewer', { name: 'Forged', ownerSubject: 'admin', mine: false });
    expect(forged).toMatchObject({ mine: true, owner: 'Vera Viewer' });
    expect(await names('admin')).not.toContain('Forged');
  });

  it('stores names and search text literally', async () => {
    const payload = `x'); drop table warden.saved_views; --`;
    const view = await create('viewer', { name: payload, state: { q: payload } });
    expect(view).toMatchObject({ name: payload, state: { q: payload } });
    expect(await names('viewer')).toContain(payload);
  });
});
