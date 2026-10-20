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
  // Stand-ins for write routes, registered after the policy hook like any later route would be.
  // The body schema shows that denied callers get 403 before input validation.
  const body = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  } as const;
  const ok = async () => ({ ok: true });
  app.post('/api/entities/:entity', { schema: { body } }, ok);
  app.put('/api/entities/:entity/:id', ok);
  app.patch('/api/entities/:entity/:id', ok);
  app.delete('/api/entities/:entity/:id', ok);
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

/** Every request that performs `action` on `entity`. */
function requests(entity: string, action: Action): [string, string, object?][] {
  const base = `/api/entities/${entity}`;
  switch (action) {
    case 'read':
      return [
        ['GET', base],
        ['GET', `${base}/1`],
        ['HEAD', base],
      ];
    case 'create':
      return [['POST', base, { name: 'x' }]];
    case 'update':
      return [
        ['PATCH', `${base}/1`],
        ['PUT', `${base}/1`],
      ];
    case 'delete':
      return [['DELETE', `${base}/1`]];
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
    for (const [method, url, payload] of requests(entity, action)) {
      const res = await send(user, method, url, payload);
      if (allowed) {
        expect(res.statusCode, `${method} ${url}`).toBe(200);
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
      const res = await send('viewer', method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // The same requests from someone allowed fail validation instead.
    expect((await send('admin', 'GET', '/api/entities/orders?limit=0')).statusCode).toBe(400);
    expect((await send('admin', 'POST', '/api/entities/users', {})).statusCode).toBe(400);
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

  it('applies the decoded route, not the raw URL', async () => {
    expect((await send('viewer', 'GET', '/%61pi/entities/orders')).statusCode).toBe(403);
    expect((await send('viewer', 'GET', '/api/entities/%6frders')).statusCode).toBe(403);
  });

  it('still requires a session before the policy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/entities/users' });
    expect(res.statusCode).toBe(401);
  });
});
