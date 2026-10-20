import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

// Every row of a partitioned table lives in a partition, so `select … from only events` sees
// none. Partitions aren't entities; the parent is.
const SCHEMA = `
  create table events (id int primary key, name text not null) partition by range (id);
  create table events_low partition of events for values from (0) to (100);
  create table events_high partition of events for values from (100) to (1000);
  insert into events values (1, 'low-1'), (5, 'low-5'), (150, 'high-150');
`;

const CONFIG = `
roles:
  admin: { grants: { '*': [read, create, update, delete, export] }, admin: [audit] }
access:
  groups:
    warden-admins: [admin]
`;

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
  const dir = mkdtempSync(join(tmpdir(), 'warden-partitioned-'));
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

const send = async (method: string, url: string, payload?: object) => {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: admin },
    ...(payload ? { payload } : {}),
  });
  const json = res.headers['content-type']?.toString().startsWith('application/json');
  return { status: res.statusCode, body: json ? res.json() : undefined, raw: res.body };
};
/** The table's rows, as a hand-written query sees them. */
const rows = async (table: string) =>
  (await sqlPool.query(`select id, name from ${table} order by id`)).rows;
const auditRows = async (action: string) =>
  (
    await sqlPool.query(
      'select entity, record_id, before, after from warden.audit_log where action = $1',
      [action],
    )
  ).rows;

describe('partitioned tables', () => {
  it('exposes the parent and not its partitions', async () => {
    expect((await send('GET', '/api/entities/events')).status).toBe(200);
    expect((await send('GET', '/api/entities/events_low')).status).toBe(404);
  });

  it('lists and counts rows across partitions', async () => {
    const res = await send('GET', '/api/entities/events?count=true&sort=id');
    expect(res.status, res.raw).toBe(200);
    expect((res.body.items as Item[]).map((i) => i.values)).toEqual(await rows('events'));
    expect(res.body.total).toBe(3);
  });

  it('exports rows across partitions', async () => {
    const res = await send('GET', '/api/export/events?sort=id');
    expect(res.status, res.raw).toBe(200);
    expect(
      res.raw
        .replace(/^\uFEFF/, '')
        .trim()
        .split(/\r?\n/),
    ).toEqual(['id,name', '1,low-1', '5,low-5', '150,high-150']);
  });

  it('gets a row from any partition', async () => {
    const res = await send('GET', '/api/entities/events/150');
    expect(res.status, res.raw).toBe(200);
    expect(res.body.values).toEqual({ id: 150, name: 'high-150' });
  });

  it('creates a row in its partition and audits it', async () => {
    const res = await send('POST', '/api/entities/events', { values: { id: 200, name: 'new' } });
    expect(res.status, res.raw).toBe(201);
    expect(await rows('events_high')).toEqual([
      { id: 150, name: 'high-150' },
      { id: 200, name: 'new' },
    ]);
    expect(await auditRows('create')).toEqual([
      { entity: 'events', record_id: '200', before: null, after: { id: 200, name: 'new' } },
    ]);
  });

  it('updates a row and audits exactly one row', async () => {
    const before = (await send('GET', '/api/entities/events/5')).body as Item;
    const res = await send('PATCH', '/api/entities/events/5', {
      version: before.version,
      values: { name: 'renamed-5' },
    });
    expect(res.status, res.raw).toBe(200);
    expect(await rows('events_low')).toEqual([
      { id: 1, name: 'low-1' },
      { id: 5, name: 'renamed-5' },
    ]);
    expect(await auditRows('update')).toEqual([
      {
        entity: 'events',
        record_id: '5',
        before: { id: 5, name: 'low-5' },
        after: { id: 5, name: 'renamed-5' },
      },
    ]);
  });

  it('deletes a row and audits exactly one row', async () => {
    const res = await send('DELETE', '/api/entities/events/150');
    expect(res.status, res.raw).toBe(204);
    expect(await rows('events_high')).toEqual([{ id: 200, name: 'new' }]);
    expect(await auditRows('delete')).toEqual([
      { entity: 'events', record_id: '150', before: { id: 150, name: 'high-150' }, after: null },
    ]);
  });
});
