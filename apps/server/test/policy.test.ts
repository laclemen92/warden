import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

// Reading needs a grant here, so read is enforced like the write actions.
const CONFIG = `
defaults: { read: granted }
tables:
  companies: { hidden: true }
  orders: { deny: [create, delete] }
roles:
  viewer: { grants: { users: [read] } }
  ops: { grants: { users: [read, update], orders: [update] } }
  admin: { grants: { '*': [read, create, update, delete] } }
  guest: { grants: {} }
access:
  groups:
    warden-viewers: [viewer]
    warden-editors: [ops]
    warden-admins: [admin]
  emailDomains:
    example.org: [guest]
`;

const USERS = ['viewer', 'editor', 'admin', 'outsider'] as const;
type User = (typeof USERS)[number];
type Action = 'read' | 'create' | 'update' | 'delete';

const ALLOWED: Record<string, Record<User, Action[]>> = {
  users: {
    viewer: ['read'],
    editor: ['read', 'update'],
    admin: ['read', 'create', 'update', 'delete'],
    outsider: [],
  },
  // The table-level deny beats admin's `*` grant.
  orders: { viewer: [], editor: ['update'], admin: ['read', 'update'], outsider: [] },
};

const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };
const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'Not Found' };

let db: TestDatabase;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
const cookies = {} as Record<User, string>;

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  idp = await startTestIdp();
  const dir = mkdtempSync(join(tmpdir(), 'warden-policy-'));
  const config = join(dir, 'warden.config.yaml');
  writeFileSync(config, CONFIG);
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: config, ...authEnv(idp) },
  });
  // Stand-ins for routes that don't exist yet, registered after the policy hook like any later
  // route would be.
  const ok = async () => ({ ok: true });
  app.put('/api/entities/:entity/:id', ok);
  app.options('/api/entities/:entity', ok);
  for (const user of USERS) cookies[user] = await login(app, user);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await db?.stop();
});

const send = (user: User, method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: cookies[user] },
    ...(payload ? { payload } : {}),
  });

// A nullable text field per entity, for updates that pass validation.
const TEXT_FIELD: Record<string, string> = { users: 'full_name', orders: 'notes' };

/**
 * Every request that performs `action` on `entity`, and its status once the policy lets it
 * through. None of them change data: creates are invalid and updates and deletes are stale.
 */
function requests(entity: string, action: Action): [string, string, object | undefined, number][] {
  const base = `/api/entities/${entity}`;
  switch (action) {
    case 'read':
      return [
        ['GET', base, undefined, 200],
        ['GET', `${base}/1`, undefined, 200],
        ['HEAD', base, undefined, 200],
      ];
    case 'create':
      return [['POST', base, { values: {} }, 400]];
    case 'update':
      return [
        [
          'PATCH',
          `${base}/1`,
          { version: 'stale', values: { [TEXT_FIELD[entity] ?? 'x']: 'x' } },
          409,
        ],
        ['PUT', `${base}/1`, undefined, 200],
      ];
    case 'delete':
      return [['DELETE', `${base}/1`, { version: 'stale', reason: 'policy test' }, 409]];
  }
}

const matrix = Object.entries(ALLOWED).flatMap(([entity, byUser]) =>
  USERS.flatMap((user) =>
    (['read', 'create', 'update', 'delete'] as const).map(
      (action) => [user, action, entity, byUser[user].includes(action)] as const,
    ),
  ),
);

describe('policy enforcement', () => {
  it.each(matrix)('%s %s %s: allowed=%s', async (user, action, entity, allowed) => {
    for (const [method, url, payload, status] of requests(entity, action)) {
      const res = await send(user, method, url, payload);
      if (allowed) {
        expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
      } else if (ALLOWED[entity]![user].length === 0) {
        // An entity the user may do nothing with is as absent as a nonexistent one.
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        if (method !== 'HEAD') expect(res.json()).toEqual(NOT_FOUND);
      } else {
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        if (method !== 'HEAD') expect(res.json()).toEqual(FORBIDDEN);
      }
    }
  });

  it('returns 403 before validating input or looking up records', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/entities/orders?limit=0'],
      ['GET', '/api/entities/orders?filter=not-json'],
      ['GET', '/api/entities/orders/does-not-exist'],
      ['POST', '/api/entities/orders', {}],
    ] as const) {
      const res = await send('editor', method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // The same requests from someone allowed fail validation instead.
    expect((await send('admin', 'GET', '/api/entities/orders?limit=0')).statusCode).toBe(400);
    expect((await send('admin', 'POST', '/api/entities/users', {})).statusCode).toBe(400);
  });

  it('shows a written row only to callers who may read it', async () => {
    const order = (await send('admin', 'GET', '/api/entities/orders/1')).json();
    // ops may update orders but not read them.
    const res = await send('editor', 'PATCH', '/api/entities/orders/1', {
      version: order.version,
      values: { notes: 'updated by ops' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: '1' });
    const after = (await send('admin', 'GET', '/api/entities/orders/1')).json();
    expect(after.values.notes).toBe('updated by ops');
  });

  it('denies methods that map to no action', async () => {
    expect((await send('admin', 'OPTIONS', '/api/entities/users')).statusCode).toBe(403);
  });

  it('404s hidden and nonexistent entities for every method, even with a * grant', async () => {
    for (const entity of ['companies', 'nope', 'pg_catalog.pg_authid']) {
      for (const action of ['read', 'create', 'update', 'delete'] as const) {
        for (const [method, url, payload] of requests(entity, action)) {
          const res = await send('admin', method, url, payload);
          expect(res.statusCode, `${method} ${url}`).toBe(404);
          if (method !== 'HEAD') expect(res.json()).toEqual(NOT_FOUND);
        }
      }
    }
  });

  it('404s entities the user may do nothing with exactly like nonexistent ones', async () => {
    for (const [user, entity] of [
      ['viewer', 'orders'],
      ['outsider', 'users'],
      ['outsider', 'orders'],
    ] as const) {
      for (const action of ['read', 'create', 'update', 'delete'] as const) {
        for (const [method, url, payload] of requests(entity, action)) {
          const res = await send(user, method, url, payload);
          const missing = await send(user, method, url.replace(entity, 'nope'), payload);
          expect(res.statusCode, `${user} ${method} ${url}`).toBe(404);
          expect(res.body).toBe(missing.body);
        }
      }
    }
  });

  it('applies the decoded route, not the raw URL', async () => {
    expect((await send('editor', 'GET', '/%61pi/entities/orders')).statusCode).toBe(403);
    expect((await send('editor', 'GET', '/api/entities/%6frders')).statusCode).toBe(403);
  });

  it('still requires a session before the policy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/entities/users' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/schema', () => {
  const schemaOf = async (user: User) =>
    (await send(user, 'GET', '/api/schema')).json() as {
      entities: { key: string; relations: { entity: string }[] }[];
    };

  it('lists only the entities the user may do something with', async () => {
    expect((await schemaOf('viewer')).entities.map((e) => e.key)).toEqual(['users']);
    // ops may update orders without reading them, so it still gets their form.
    expect((await schemaOf('editor')).entities.map((e) => e.key).sort()).toEqual([
      'orders',
      'users',
    ]);
    expect(await schemaOf('outsider')).toEqual({ entities: [] });
  });

  it('prunes relations to entities the user can no longer see', async () => {
    const users = (await schemaOf('viewer')).entities.find((e) => e.key === 'users')!;
    expect(users.relations).toEqual([]);
    const editorUsers = (await schemaOf('editor')).entities.find((e) => e.key === 'users')!;
    expect(editorUsers.relations.map((r) => r.entity)).toEqual(['orders']);
  });
});

describe('GET /api/capabilities', () => {
  it.each(USERS)('lists exactly the actions the routes allow %s', async (user) => {
    const res = await send(user, 'GET', '/api/capabilities');
    expect(res.statusCode).toBe(200);
    const { entities } = res.json() as { entities: Record<string, { actions: Action[] }> };
    for (const [entity, byUser] of Object.entries(ALLOWED)) {
      // Entities the user may do nothing with aren't listed at all.
      expect(entities[entity]).toEqual(
        byUser[user].length > 0 ? { actions: byUser[user] } : undefined,
      );
    }
    // The capabilities agree with what each route actually does.
    for (const [entity, { actions }] of Object.entries(entities)) {
      for (const action of ['read', 'create', 'update', 'delete'] as const) {
        for (const [method, url, payload] of requests(entity, action)) {
          const status = (await send(user, method, url, payload)).statusCode;
          expect(status === 403, `${user} ${method} ${url}`).toBe(!actions.includes(action));
          expect(status, `${user} ${method} ${url}`).not.toBe(404);
        }
      }
    }
  });

  it.each(USERS)('leaves out hidden entities and agrees with the schema for %s', async (user) => {
    const { entities } = (await send(user, 'GET', '/api/capabilities')).json();
    expect(entities).not.toHaveProperty('companies');
    const schema = (await send(user, 'GET', '/api/schema')).json() as {
      entities: { key: string }[];
    };
    expect(Object.keys(entities).sort()).toEqual(schema.entities.map((e) => e.key).sort());
  });

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(res.statusCode).toBe(401);
  });
});
