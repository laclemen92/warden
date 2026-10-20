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
  insert into docs values (1, '{"a": "x\\u0000y", "k\\u0000": ["\\\\u0000", "\\\\\\u0000"]}', null);
  insert into stamps values ('2026-01-01', null);
`;

const CONFIG = `
tables:
  stamps:
    requireReason: [update, delete]
roles:
  admin: { grants: { '*': [read, create, update, delete] }, admin: [audit] }
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
  return { status: res.statusCode, body: res.body ? res.json() : undefined, raw: res.body };
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
