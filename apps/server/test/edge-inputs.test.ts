import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden, parseBodyLimit } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

const SCHEMA = `
  create table docs (id int primary key, body json, data jsonb);
  create table stamps (at date primary key, note text);
  create table codes (code text primary key);
  create table measures (
    id int8 primary key, f4 float4, f8 float8, n numeric(5, 2), m money,
    d date, t time, ts timestamptz, s varchar(3)
  );
  insert into docs values (1, '{"a": "x\\u0000y", "k\\u0000": ["\\\\u0000", "\\\\\\u0000"]}', null);
  insert into stamps values ('2026-01-01', null);
  insert into measures (id, d) values (1, '2026-01-01'), (2, '2026-01-02'), (3, null);
`;

const CONFIG = `
tables:
  stamps:
    requireReason: [update, delete]
roles:
  admin: { grants: { '*': [read, create, update, delete, export] }, admin: [audit] }
access:
  groups:
    warden-admins: [admin]
`;

const BODY_LIMIT = 2 * 1024 * 1024;

interface Item {
  id: string;
  version: string;
  values: Record<string, unknown>;
}

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
let admin: string;

beforeAll(async () => {
  db = await startPostgres({ sql: [SCHEMA] });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  const dir = mkdtempSync(join(tmpdir(), 'warden-edge-'));
  const config = join(dir, 'warden.config.yaml');
  writeFileSync(config, CONFIG);
  app = await createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: config,
      WARDEN_BODY_LIMIT: '2mb',
      ...authEnv(idp),
    },
  });
  admin = await login(app, 'admin');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const send = async (method: string, url: string, payload?: object | string) => {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: {
      cookie: admin,
      ...(typeof payload === 'string' ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
  const json = res.headers['content-type']?.toString().startsWith('application/json');
  return { status: res.statusCode, body: json ? res.json() : undefined, raw: res.body };
};
const sqlRows = async (query: string, params: unknown[] = []) =>
  (await sqlPool.query<Record<string, unknown>>(query, params)).rows;

describe('deeply nested JSON', () => {
  // Built as text: a JS value this deep can't be serialized by JSON.stringify.
  const nested = (depth: number) => `${'['.repeat(depth)}1${']'.repeat(depth)}`;

  it('rejects values nested too deeply with a 400', async () => {
    for (const depth of [101, 200_000]) {
      const res = await send(
        'POST',
        '/api/entities/docs',
        `{"values": {"id": 2, "data": ${nested(depth)}}}`,
      );
      expect(res.status, res.raw).toBe(400);
      expect(res.body.details).toEqual([
        { field: 'data', message: 'must be nested at most 100 levels deep' },
      ]);
    }
    expect(await sqlRows('select id from docs where id = 2')).toEqual([]);
  });

  it('accepts values up to the limit', async () => {
    const res = await send(
      'POST',
      '/api/entities/docs',
      `{"values": {"id": 3, "data": ${nested(100)}}}`,
    );
    expect(res.status, res.raw).toBe(201);
    await sqlPool.query('delete from docs where id = 3');
  });
});

describe('WARDEN_BODY_LIMIT', () => {
  it('parses sizes', () => {
    expect(parseBodyLimit(undefined)).toBe(1024 * 1024);
    expect(parseBodyLimit('2mb')).toBe(BODY_LIMIT);
    expect(parseBodyLimit(' 512KB ')).toBe(512 * 1024);
    expect(parseBodyLimit('4096')).toBe(4096);
    for (const bad of ['0', '-1', '1gb', 'lots', '1.5mb']) {
      expect(() => parseBodyLimit(bad), bad).toThrow(/WARDEN_BODY_LIMIT/);
    }
  });

  it('rejects larger bodies with a 413 and accepts smaller ones', async () => {
    const body = (size: number) => JSON.stringify({ values: { id: 4, data: 'x'.repeat(size) } });
    expect((await send('POST', '/api/entities/docs', body(BODY_LIMIT))).status).toBe(413);
    // Over Fastify's 1 MiB default, so the configured limit applies.
    const res = await send('POST', '/api/entities/docs', body(1.5 * 1024 * 1024));
    expect(res.status, res.raw.slice(0, 200)).toBe(201);
    await sqlPool.query('delete from docs where id = 4');
  });
});

describe('record ids the key column cannot hold', () => {
  const ids: [string, string][] = [
    ['docs', '1.5'],
    ['docs', '1e0'],
    ['docs', '2147483648'],
    ['stamps', '2026-02-30'],
    ['stamps', '2026-01-01T25:00'],
    ['codes', 'a%00b'],
  ];

  it.each(ids)('%s/%s is a 404 on every route', async (entity, id) => {
    const notFound = { statusCode: 404, error: 'Not Found', message: 'Not Found' };
    const responses = [
      await send('GET', `/api/entities/${entity}/${id}`),
      await send('GET', `/api/entities/${entity}/${id}/history`),
      await send('PATCH', `/api/entities/${entity}/${id}`, { version: 'v', values: { note: 'x' } }),
      await send('DELETE', `/api/entities/${entity}/${id}`),
    ];
    for (const res of responses) {
      expect(res.status, res.raw).toBe(404);
      expect(res.body).toEqual(notFound);
    }
  });
});

describe('NUL characters in json columns', () => {
  const auditOf = async (action: string) =>
    (
      await sqlRows(
        `select before, after from warden.audit_log where entity = 'docs' and action = $1`,
        [action],
      )
    ).at(-1);

  it('keeps rows holding them writable, recording each NUL as text in the audit log', async () => {
    const read = await send('GET', '/api/entities/docs/1');
    expect(read.status, read.raw).toBe(200);
    const item = read.body as Item;
    expect(item.values.body).toEqual({ a: 'x\u0000y', 'k\u0000': ['\\u0000', '\\\u0000'] });

    const res = await send('PATCH', '/api/entities/docs/1', {
      version: item.version,
      values: { data: { note: 'updated' } },
    });
    expect(res.status, res.raw).toBe(200);
    expect(await auditOf('update')).toEqual({
      before: {
        id: 1,
        body: { a: 'x\\u0000y', 'k\\u0000': ['\\u0000', '\\\\u0000'] },
        data: null,
      },
      after: {
        id: 1,
        body: { a: 'x\\u0000y', 'k\\u0000': ['\\u0000', '\\\\u0000'] },
        data: { note: 'updated' },
      },
    });
    // The row itself is unchanged.
    expect((await sqlRows('select body::text from docs where id = 1'))[0]!.body).toContain(
      'x\\u0000y',
    );

    expect((await send('DELETE', '/api/entities/docs/1')).status).toBe(204);
    expect((await auditOf('delete'))!.before).toMatchObject({ id: 1 });
  });

  it('accepts them in new json values', async () => {
    const res = await send('POST', '/api/entities/docs', { values: { id: 5, body: ['\u0000'] } });
    expect(res.status, res.raw).toBe(201);
    expect((await auditOf('create'))!.after).toEqual({ id: 5, body: ['\\u0000'], data: null });
  });
});

describe('filter and cursor values the column cannot hold', () => {
  const list = (query: Record<string, string>) =>
    send('GET', `/api/entities/measures?${new URLSearchParams(query)}`);
  const exportCsv = (query: Record<string, string>) =>
    send('GET', `/api/export/measures?${new URLSearchParams(query)}`);
  // Cursors are opaque but only base64url JSON, so a client can build one.
  const forge = (s: string, v: unknown[]) =>
    Buffer.from(JSON.stringify({ s, v })).toString('base64url');

  // Each value either is rejected with a 400 or runs in Postgres; none may reach it and fail.
  const values: [string, string, boolean][] = [
    ['id', '1.5', false],
    ['id', '1e0', false],
    ['id', '9223372036854775808', false],
    ['id', '-9223372036854775808', true],
    ['f4', '1e39', false],
    ['f4', '1e-46', false],
    ['f4', '3.4028235e38', true],
    ['f8', '1e400', false],
    ['f8', '1e-400', false],
    ['f8', '5e-324', true],
    ['n', '1e131072', false],
    ['n', '0e-20000', false],
    ['n', '123456.789', true],
    ['m', '1e5', false],
    ['m', '92233720368547758.08', false],
    ['m', '-92233720368547758.08', true],
    ['d', '2026-02-30', false],
    ['d', '0000-01-01', false],
    ['d', '2024-02-29', true],
    ['t', '24:00:01', false],
    ['t', '24:00:00', true],
    ['ts', '2026-01-01T00:00+16:00', false],
    ['ts', '2026-01-01T23:59:60.5', false],
    ['ts', '2026-01-01T00:00+15:59', true],
    ['s', 'a\u0000b', false],
    ['s', 'longer than the column', true],
  ];

  it.each(values)('%s = %j on list and count (valid: %s)', async (field, value, ok) => {
    for (const filter of [
      { field, op: 'eq', value },
      { field, op: 'lt', value },
      { field, op: 'in', value: [value] },
    ]) {
      for (const count of ['false', 'true']) {
        const res = await list({ filter: JSON.stringify(filter), count });
        expect(res.status, res.raw).toBe(ok ? 200 : 400);
        if (!ok) expect(res.body.message).toBe('invalid filter');
      }
    }
  });

  it.each(values)('%s = %j on export (valid: %s)', async (field, value, ok) => {
    const res = await exportCsv({ filter: JSON.stringify({ field, op: 'eq', value }) });
    expect(res.status, res.raw).toBe(ok ? 200 : 400);
    if (!ok) expect(res.body.message).toBe('invalid export');
  });

  it('rejects NUL in text operators, and ignores it in search', async () => {
    const filter = JSON.stringify({ field: 's', op: 'contains', value: '\u0000' });
    expect((await list({ filter })).status).toBe(400);
    expect((await exportCsv({ filter })).status).toBe(400);
    for (const res of [await list({ q: 'a\u0000' }), await exportCsv({ q: 'a\u0000' })]) {
      expect(res.status, res.raw).toBe(200);
    }
  });

  it.each(values)('%s = %j in a cursor (valid: %s)', async (field, value, ok) => {
    const sort = field === 'id' ? 'id' : `${field},id`;
    const cursor = forge(sort, field === 'id' ? [value] : [value, '1']);
    for (const count of ['false', 'true']) {
      const res = await list({ sort, cursor, count });
      expect(res.status, res.raw).toBe(ok ? 200 : 400);
      if (!ok) expect(res.body.message).toBe('invalid cursor');
    }
  });

  it('still pages with real cursors', async () => {
    const first = await list({ sort: 'd', limit: '1' });
    expect(first.status, first.raw).toBe(200);
    const second = await list({ sort: 'd', limit: '1', cursor: first.body.nextCursor });
    expect(second.status, second.raw).toBe(200);
    expect(second.body.items.map((i: Item) => i.values.d)).toEqual(['2026-01-02']);
  });
});
