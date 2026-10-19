import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';
import type { MockOidc } from '@wardenhq/mock-oidc';

const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
);

// A composite-key table on top of the example schema.
const FIXTURES = `
  create table order_tags (
    order_id bigint not null references orders (id),
    tag      text not null,
    primary key (order_id, tag)
  );
  insert into order_tags (order_id, tag) values (1, 'gift'), (1, 'rush'), (2, 'gift');
`;

interface Item {
  id: string | null;
  values: Record<string, unknown>;
}
interface ListBody {
  items: Item[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

let db: TestDatabase;
let sqlPool: pg.Pool;
let app: Awaited<ReturnType<typeof createWarden>>;
let idp: MockOidc;
let cookie: string;

beforeAll(async () => {
  db = await startPostgres({
    sql: [
      await readExampleSql('basic/schema.sql'),
      await readExampleSql('basic/seed.sql'),
      FIXTURES,
    ],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: EXAMPLE_CONFIG, ...authEnv(idp) },
  });
  cookie = await login(app);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json(), raw: res.body };
};
const list = async (entity: string, query: Record<string, string | number | boolean> = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
  );
  const res = await get(`/api/entities/${entity}?${qs}`);
  expect(res.status, res.raw).toBe(200);
  return res.body as ListBody;
};
const sqlIds = async (query: string) =>
  (await sqlPool.query<{ id: string }>(query)).rows.map((r) => r.id);

/** Follow nextCursor until exhausted, returning every id in order. */
async function walk(entity: string, query: Record<string, string | number> = {}) {
  const ids: (string | null)[] = [];
  let cursor: string | null = null;
  do {
    const page: ListBody = await list(entity, { ...query, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

describe('GET /api/entities/:entity', () => {
  it('lists rows with ids and only exposed columns', async () => {
    const page = await list('users');
    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.total).toBeUndefined();

    const first = page.items[0]!;
    expect(first.id).toBe(String(first.values.id));
    expect(Object.keys(first.values)).not.toContain('password_hash');
    expect(JSON.stringify(page)).not.toContain('not-a-real-hash');
  });

  it('returns bigints as strings and timestamps with full precision', async () => {
    const { values } = (await list('users', { limit: 1 })).items[0]!;
    expect(typeof values.id).toBe('string');
    expect(values.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\+00$/);
  });

  it('applies the configured default sort with a primary-key tiebreak', async () => {
    // Every seeded user shares one created_at, so the order is decided by id alone.
    const page = await list('users', { limit: 5 });
    expect(page.items.map((i) => i.id)).toEqual(
      await sqlIds('select id from users order by created_at desc, id limit 5'),
    );
  });

  it('walks every row exactly once with cursor pagination', async () => {
    const ids = await walk('users', { limit: 77 });
    expect(ids).toEqual(await sqlIds('select id from users order by created_at desc, id'));
  });

  it('paginates correctly over nullable sort columns in both directions', async () => {
    expect(await walk('users', { sort: '-last_login_at', limit: 64 })).toEqual(
      await sqlIds('select id from users order by last_login_at desc nulls last, id'),
    );
    expect(await walk('users', { sort: 'last_login_at,-email', limit: 64 })).toEqual(
      await sqlIds('select id from users order by last_login_at nulls last, email desc, id'),
    );
  });

  it('paginates with cursors through filtered results', async () => {
    const filter = JSON.stringify({ field: 'status', op: 'in', value: ['paid', 'refunded'] });
    expect(await walk('orders', { filter, sort: '-total', limit: 250 })).toEqual(
      await sqlIds(
        `select id from orders where status in ('paid', 'refunded') order by total desc nulls last, id`,
      ),
    );
  });

  it('supports offset pagination and total counts', async () => {
    const page = await list('orders', { sort: 'id', offset: 10, limit: 3, count: true });
    expect(page.items.map((i) => i.id)).toEqual(['11', '12', '13']);
    expect(page.total).toBe(5000);
  });

  it('filters and counts with the same conditions', async () => {
    const filter = JSON.stringify({
      and: [
        { field: 'status', op: 'eq', value: 'paid' },
        { field: 'total', op: 'gte', value: '500' },
      ],
    });
    const page = await list('orders', { filter, count: true, limit: 1 });
    const [{ n }] = (
      await sqlPool.query<{ n: string }>(
        `select count(*) as n from orders where status = 'paid' and total >= 500`,
      )
    ).rows as [{ n: string }];
    expect(page.total).toBe(Number(n));
  });

  it('searches the configured searchable columns', async () => {
    const page = await list('users', { q: 'user42@', count: true });
    expect(page.items.map((i) => i.values.email)).toEqual(['user42@company18.example']);
    expect(page.total).toBe(1);
  });

  it('lists composite-key rows with opaque ids', async () => {
    const page = await list('order_tags', { count: true });
    expect(page.total).toBe(3);
    expect(page.items.map((i) => i.values.tag)).toEqual(['gift', 'rush', 'gift']);
    for (const item of page.items) expect(item.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await walk('order_tags', { limit: 1 })).toHaveLength(3);
  });

  it.each([
    [{ filter: '{not json' }, 'filter must be valid JSON'],
    [{ filter: JSON.stringify({ field: 'password_hash', op: 'isNull' }) }, 'invalid filter'],
    [
      { filter: JSON.stringify({ field: 'id', op: 'eq', value: '1; drop table users' }) },
      'invalid filter',
    ],
    [{ sort: 'password_hash' }, 'unknown field "password_hash"'],
    [{ sort: 'metadata' }, 'cannot sort by "metadata"'],
    [{ cursor: 'garbage!' }, 'invalid cursor'],
    [{ cursor: 'eyJzIjoiaWQiLCJ2IjpbIjEiXX0', offset: 1 }, 'use either cursor or offset, not both'],
  ])('rejects %j', async (query, message) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    );
    const res = await get(`/api/entities/users?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
  });

  it('returns filter error details', async () => {
    const filter = JSON.stringify({ field: 'role', op: 'eq', value: 'superuser' });
    const res = await get(`/api/entities/users?filter=${encodeURIComponent(filter)}`);
    expect(res.body.details).toEqual([
      { path: 'value', message: 'expected one of "member", "admin", "owner"' },
    ]);
  });

  it('rejects cursors from a different sort or with tampered values', async () => {
    const { nextCursor } = await list('users', { sort: 'email', limit: 1 });
    const other = await get(`/api/entities/users?sort=-email&cursor=${nextCursor}`);
    expect(other.body.message).toBe('cursor does not match the current sort');

    const tampered = Buffer.from(
      JSON.stringify({ s: 'email,id', v: ['a', 'not-a-number'] }),
    ).toString('base64url');
    const bad = await get(`/api/entities/users?sort=email&cursor=${tampered}`);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('invalid cursor');
  });

  it('validates limit and offset bounds', async () => {
    expect((await get('/api/entities/users?limit=501')).status).toBe(400);
    expect((await get('/api/entities/users?limit=0')).status).toBe(400);
    expect((await get('/api/entities/users?offset=-1')).status).toBe(400);
  });

  it('404s for unknown entities', async () => {
    expect((await get('/api/entities/nope')).status).toBe(404);
    expect((await get('/api/entities/pg_catalog.pg_authid')).status).toBe(404);
  });
});

describe('GET /api/entities/:entity/:id', () => {
  it('returns a single row without hidden columns', async () => {
    const res = await get('/api/entities/users/42');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('42');
    expect(res.body.values.email).toBe('user42@company18.example');
    expect(res.body.values).not.toHaveProperty('password_hash');
  });

  it('round-trips composite ids from list responses', async () => {
    const { items } = await list('order_tags');
    for (const item of items) {
      const res = await get(`/api/entities/order_tags/${item.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(item);
    }
  });

  it.each(['999999', 'abc', '1 or 1=1', '%27%3B%20drop%20table%20users'])(
    '404s for id %s',
    async (id) => {
      expect((await get(`/api/entities/users/${id}`)).status).toBe(404);
    },
  );

  it('404s for malformed composite ids', async () => {
    const wrongArity = Buffer.from(JSON.stringify(['1'])).toString('base64url');
    for (const id of ['1', wrongArity, 'bm90IGpzb24']) {
      expect((await get(`/api/entities/order_tags/${id}`)).status).toBe(404);
    }
  });
});

describe('hidden entities', () => {
  it('are unreachable through list and get', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-entities-'));
    const config = join(dir, 'warden.config.yaml');
    writeFileSync(config, 'tables:\n  companies: { hidden: true }\n');
    const hidden = await createWarden({
      env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: config, ...authEnv(idp) },
    });
    // Sessions live in the database, so the cookie from the main app works here too.
    const headers = { cookie };
    try {
      for (const url of ['/api/entities/companies', '/api/entities/companies/1']) {
        expect((await hidden.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
      }
      const users = await hidden.inject({ method: 'GET', url: '/api/entities/users', headers });
      expect(users.statusCode).toBe(200);
    } finally {
      await hidden.close();
    }
  });
});
