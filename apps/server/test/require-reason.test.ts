import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveSchema } from '@wardenhq/core';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

const CONFIG = `
tables:
  companies:
    requireReason: [create, update, delete]
  users:
    columns:
      password_hash: { hidden: true }
    requireReason: [delete]
  orders:
    requireReason: [update]
    deny: [update]
  secrets:
    hidden: true
    requireReason: [create]
roles:
  viewer: { grants: { '*': [read] } }
  admin: { grants: { '*': [read, create, update, delete] } }
access:
  groups:
    warden-viewers: [viewer]
    warden-admins: [admin]
`;

interface Item {
  id: string;
  version: string;
  values: Record<string, unknown>;
}

const REQUIRED = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'a reason is required for this change',
};

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
let admin: string;
let viewer: string;

beforeAll(async () => {
  db = await startPostgres({
    sql: [
      await readExampleSql('basic/schema.sql'),
      await readExampleSql('basic/seed.sql'),
      'create table secrets (id serial primary key, value text)',
    ],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  const dir = mkdtempSync(join(tmpdir(), 'warden-reason-'));
  const config = join(dir, 'warden.config.yaml');
  writeFileSync(config, CONFIG);
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: config, ...authEnv(idp) },
  });
  admin = await login(app, 'admin');
  viewer = await login(app, 'viewer');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const send = async (method: string, url: string, payload?: object, cookie = admin) => {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined, raw: res.body };
};
const auditCount = async () =>
  Number((await sqlPool.query('select count(*) from warden.audit_log')).rows[0].count);

const newCompany = async (name: string) => {
  const res = await send('POST', '/api/entities/companies', {
    values: { name },
    reason: 'setup',
  });
  expect(res.status, res.raw).toBe(201);
  return res.body as Item;
};

describe('required reasons', () => {
  it('tells the UI which writes need one', async () => {
    const { entities } = (await send('GET', '/api/schema')).body as EffectiveSchema;
    const byKey = Object.fromEntries(entities.map((e) => [e.key, e.requireReason]));
    expect(byKey).toEqual({
      companies: ['create', 'update', 'delete'],
      users: ['delete'],
      orders: ['update'],
    });
  });

  it('rejects a create, update, or delete without one, writing nothing', async () => {
    const item = await newCompany('Needs reasons');
    const url = `/api/entities/companies/${item.id}`;
    const before = await auditCount();

    for (const reason of [undefined, '', '   \n\t']) {
      const extra = reason === undefined ? {} : { reason };
      const created = await send('POST', '/api/entities/companies', {
        values: { name: 'No reason' },
        ...extra,
      });
      expect(created).toMatchObject({ status: 400, body: REQUIRED });
      const updated = await send('PATCH', url, {
        version: item.version,
        values: { name: 'x' },
        ...extra,
      });
      expect(updated).toMatchObject({ status: 400, body: REQUIRED });
      const deleted = await send('DELETE', url, { version: item.version, ...extra });
      expect(deleted).toMatchObject({ status: 400, body: REQUIRED });
    }
    // A bare DELETE has no body at all.
    expect(await send('DELETE', url)).toMatchObject({ status: 400, body: REQUIRED });

    expect(await auditCount()).toBe(before);
    const rows = await sqlPool.query('select name from companies where id = $1', [item.id]);
    expect(rows.rows).toEqual([{ name: 'Needs reasons' }]);
    expect((await sqlPool.query("select 1 from companies where name = 'No reason'")).rowCount).toBe(
      0,
    );
  });

  it('accepts the write with a reason and records it', async () => {
    const item = await newCompany('Has reasons');
    const url = `/api/entities/companies/${item.id}`;
    const updated = await send('PATCH', url, {
      version: item.version,
      values: { name: 'Renamed' },
      reason: ' typo ',
    });
    expect(updated.status, updated.raw).toBe(200);
    const deleted = await send('DELETE', url, {
      version: (updated.body as Item).version,
      reason: 'duplicate',
    });
    expect(deleted.status, deleted.raw).toBe(204);
    const { rows } = await sqlPool.query(
      'select action, reason from warden.audit_log where record_id = $1 order by id',
      [item.id],
    );
    expect(rows).toEqual([
      { action: 'create', reason: 'setup' },
      { action: 'update', reason: 'typo' },
      { action: 'delete', reason: 'duplicate' },
    ]);
  });

  it('only applies to the configured actions', async () => {
    const user = await send('POST', '/api/entities/users', {
      values: { email: 'no-reason@example.com' },
    });
    // Fails on the hidden NOT NULL password_hash, not on the reason.
    expect(user.status).toBe(400);
    expect(user.body.message).not.toBe(REQUIRED.message);
    const ada = (await send('GET', '/api/entities/users/1')).body as Item;
    const updated = await send('PATCH', '/api/entities/users/1', {
      version: ada.version,
      values: { full_name: 'No reason needed' },
    });
    expect(updated.status, updated.raw).toBe(200);
    expect(await send('DELETE', '/api/entities/users/1')).toMatchObject({
      status: 400,
      body: REQUIRED,
    });
  });

  it('checks permissions and existence first', async () => {
    // Denied by role or by the table: 403, whether or not a reason was given.
    expect((await send('POST', '/api/entities/companies', { values: {} }, viewer)).status).toBe(
      403,
    );
    expect((await send('PATCH', '/api/entities/orders/1', { values: {} })).status).toBe(403);
    // A hidden table 404s like a nonexistent one, its requireReason notwithstanding.
    const hidden = await send('POST', '/api/entities/secrets', { values: {} });
    const missing = await send('POST', '/api/entities/nonexistent', { values: {} });
    expect(hidden).toEqual(missing);
    expect(hidden.status).toBe(404);
  });
});
