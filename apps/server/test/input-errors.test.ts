import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

// Inputs that used to reach Postgres and fail with a 500. Each must be a 400 (or the 404 a
// missing record gets) and change nothing.
const SCHEMA = `
  create table notes (id int primary key, body text);
  create table odd (id int primary key, flags bit(3), span int4range, doc xml);
  insert into notes values (1, 'one');
`;

const CONFIG = `
roles:
  admin:
    grants: { '*': [read, create, update, delete, export] }
    admin: [audit, roles, views]
access:
  groups:
    warden-admins: [admin]
`;

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
let admin: string;

beforeAll(async () => {
  db = await startPostgres({ sql: [SCHEMA] });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  const dir = mkdtempSync(join(tmpdir(), 'warden-input-errors-'));
  const config = join(dir, 'warden.config.yaml');
  writeFileSync(config, CONFIG);
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: config, ...authEnv(idp) },
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
const count = async (table: string) =>
  Number((await sqlPool.query(`select count(*) from ${table}`)).rows[0].count);

describe('deeply nested filters', () => {
  // Built as text: zod overflows the stack on these, so they must be refused before parsing.
  const nested = (depth: number) =>
    `${'{"and":['.repeat(depth)}{"field":"id","op":"eq","value":1}${']}'.repeat(depth)}`;
  const query = (depth: number) => encodeURIComponent(nested(depth));

  it('rejects them with a 400 on every route that takes a filter', async () => {
    for (const depth of [9, 700, 1500]) {
      for (const url of [
        `/api/entities/notes?filter=${query(depth)}`,
        `/api/export/notes?filter=${query(depth)}`,
      ]) {
        const res = await send('GET', url);
        expect(res.status, `${url.slice(0, 40)} ${depth}: ${res.raw}`).toBe(400);
        expect(res.raw).toContain('filters can nest at most 8 levels');
      }
      const view = await send(
        'POST',
        '/api/views',
        `{"entity":"notes","name":"deep ${depth}","state":{"filter":${nested(depth)}}}`,
      );
      expect(view.status, view.raw).toBe(400);
      expect(view.raw).toContain('filters can nest at most 8 levels');
    }
    expect(await count('warden.saved_views')).toBe(0);
  });

  it('still accepts filters up to the limit', async () => {
    const list = await send('GET', `/api/entities/notes?filter=${query(7)}`);
    expect(list.status, list.raw).toBe(200);
    expect(list.body.items).toHaveLength(1);
    // `not` nests one JSON level per filter level instead of two.
    const nots = `${'{"not":'.repeat(7)}{"field":"id","op":"eq","value":1}${'}'.repeat(7)}`;
    const res = await send('GET', `/api/entities/notes?filter=${encodeURIComponent(nots)}`);
    expect(res.status, res.raw).toBe(200);
  });
});

describe('NUL characters in free text', () => {
  it('rejects them in a write reason, and writes nothing', async () => {
    const created = await send('POST', '/api/entities/notes', {
      values: { id: 2, body: 'two' },
      reason: 'because\u0000',
    });
    expect(created.status, created.raw).toBe(400);
    expect(created.body.message).toMatch(/^body\/reason /);
    expect(await count('notes')).toBe(1);
    expect(await count('warden.audit_log')).toBe(0);
  });

  it('rejects them in saved-view names', async () => {
    const res = await send('POST', '/api/views', {
      entity: 'notes',
      name: 'mine\u0000',
      state: {},
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.message).toMatch(/^body\/name /);
    const view = await send('POST', '/api/views', { entity: 'notes', name: 'mine', state: {} });
    expect(view.status, view.raw).toBe(201);
    const renamed = await send('PATCH', `/api/views/${view.body.id}`, { name: 'x\u0000' });
    expect(renamed.status, renamed.raw).toBe(400);
    expect(renamed.body.message).toMatch(/^body\/name /);
    expect((await sqlPool.query('select name from warden.saved_views')).rows).toEqual([
      { name: 'mine' },
    ]);
  });

  it('rejects them in audit search parameters', async () => {
    for (const param of ['entity', 'actor', 'action']) {
      const res = await send('GET', `/api/audit?${param}=a%00b`);
      expect(res.status, `${param}: ${res.raw}`).toBe(400);
      expect(res.body.message).toMatch(new RegExp(`^querystring/${param} `));
    }
  });

  it('rejects them in role assignments and session revocation', async () => {
    for (const method of ['POST', 'DELETE']) {
      for (const body of [
        { email: 'a@example.com', role: 'admin\u0000' },
        { email: 'a\u0000@example.com', role: 'admin' },
      ]) {
        const res = await send(method, '/api/admin/roles/assignments', body);
        expect(res.status, `${method} ${JSON.stringify(body)}: ${res.raw}`).toBe(400);
        expect(res.body.message).toMatch(/^body\/(email|role) /);
      }
    }
    const res = await send('DELETE', '/api/admin/roles/sessions', { subject: 'x\u0000' });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.message).toMatch(/^body\/subject /);
    expect(await count('warden.role_assignments')).toBe(0);
  });
});

describe('out-of-range ids and dates', () => {
  it('treats saved-view ids beyond bigint as missing', async () => {
    for (const id of ['9223372036854775808', '9999999999999999999']) {
      expect((await send('GET', `/api/views/${id}`)).status).toBe(404);
      expect((await send('PATCH', `/api/views/${id}`, { name: 'x' })).status).toBe(404);
      expect((await send('DELETE', `/api/views/${id}`)).status).toBe(404);
    }
  });

  it('rejects audit date bounds Postgres cannot hold', async () => {
    for (const bound of ['from', 'to']) {
      const res = await send('GET', `/api/audit?${bound}=0000-01-01T00:00:00Z`);
      expect(res.status, `${bound}: ${res.raw}`).toBe(400);
      expect(res.body.message).toBe(`querystring/${bound} is not a valid date-time`);
    }
    const ok = await send('GET', '/api/audit?from=0001-01-01T00:00:00Z&to=9999-12-31T23:59:59Z');
    expect(ok.status, ok.raw).toBe(200);
  });
});

describe('data errors from columns Warden passes through as text', () => {
  it.each([
    ['bit(3)', { flags: '1111' }],
    ['int4range', { span: '[2,1]' }],
    ['xml', { doc: '<a>' }],
  ])('maps a bad %s value to a generic 400', async (_type, values) => {
    const res = await send('POST', '/api/entities/odd', { values: { id: 1, ...values } });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.details).toEqual([{ message: 'a value is invalid for its field' }]);
    expect(await count('odd')).toBe(0);
  });

  it('still writes valid values', async () => {
    const res = await send('POST', '/api/entities/odd', {
      values: { id: 1, flags: '101', span: '[1,2)', doc: '<a/>' },
    });
    expect(res.status, res.raw).toBe(201);
  });
});
