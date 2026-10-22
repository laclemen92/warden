import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

// Postgres doesn't carry a parent's primary key over to INHERITS children, so every table here
// has a row with id 5. `events_archive` is hidden and `events_locked` may not be written; neither
// may be reached through `events`.
const SCHEMA = `
  create table events (id int primary key, name text not null);
  create table events_archive (primary key (id)) inherits (events);
  create table events_locked (primary key (id)) inherits (events);
  insert into events values (1, 'parent-1'), (5, 'parent-5');
  insert into events_archive values (5, 'archived-5'), (6, 'archived-6');
  insert into events_locked values (5, 'locked-5'), (7, 'locked-7');
`;

const CONFIG = `
tables:
  events: { allowDelete: true }
  events_archive:
    hidden: true
  events_locked:
    deny: [update, delete]
    allowDelete: true
roles:
  admin:
    grants:
      '*': [read, create, update, export]
      events: [delete]
      events_locked: [delete]
    admin: [audit]
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
  const dir = mkdtempSync(join(tmpdir(), 'warden-inherits-'));
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
/** Each table's own rows, as hand-written `only` queries see them. */
const own = async (table: string) =>
  (await sqlPool.query(`select id, name from only ${table} order by id`)).rows;
const auditRows = async (action: string) =>
  (
    await sqlPool.query(
      'select entity, record_id, before, after from warden.audit_log where action = $1',
      [action],
    )
  ).rows;

describe('tables with INHERITS children', () => {
  it('lists and counts only the parent’s own rows', async () => {
    const res = await send('GET', '/api/entities/events?count=true&sort=id');
    expect(res.status, res.raw).toBe(200);
    expect((res.body.items as Item[]).map((i) => i.values)).toEqual(await own('events'));
    expect(res.body.total).toBe(2);
  });

  it('exports only the parent’s own rows', async () => {
    const res = await send('GET', '/api/export/events?sort=id');
    expect(res.status, res.raw).toBe(200);
    expect(
      res.raw
        .replace(/^\uFEFF/, '')
        .trim()
        .split(/\r?\n/),
    ).toEqual(['id,name', '1,parent-1', '5,parent-5']);
  });

  it('does not reach hidden child rows through the parent', async () => {
    expect((await send('GET', '/api/entities/events_archive')).status).toBe(404);
    expect((await send('GET', '/api/entities/events/6')).status).toBe(404);
    const filtered = await send('GET', '/api/entities/events?q=name%3Darchived-5');
    expect(filtered.status, filtered.raw).toBe(200);
    expect(filtered.body.items).toEqual([]);
  });

  it('gets the parent row when a child has the same primary key', async () => {
    const res = await send('GET', '/api/entities/events/5');
    expect(res.status, res.raw).toBe(200);
    expect(res.body.values).toEqual({ id: 5, name: 'parent-5' });
  });

  it('updates exactly the parent row and audits exactly one row', async () => {
    const before = (await send('GET', '/api/entities/events/5')).body as Item;
    const res = await send('PATCH', '/api/entities/events/5', {
      version: before.version,
      values: { name: 'renamed-5' },
    });
    expect(res.status, res.raw).toBe(200);
    expect(await own('events')).toEqual([
      { id: 1, name: 'parent-1' },
      { id: 5, name: 'renamed-5' },
    ]);
    expect(await own('events_archive')).toEqual([
      { id: 5, name: 'archived-5' },
      { id: 6, name: 'archived-6' },
    ]);
    expect(await own('events_locked')).toEqual([
      { id: 5, name: 'locked-5' },
      { id: 7, name: 'locked-7' },
    ]);
    expect(await auditRows('update')).toEqual([
      {
        entity: 'events',
        record_id: '5',
        before: { id: 5, name: 'parent-5' },
        after: { id: 5, name: 'renamed-5' },
      },
    ]);
  });

  it('does not update or delete child rows the parent has no row for', async () => {
    expect(
      (await send('PATCH', '/api/entities/events/7', { version: 'x', values: { name: 'x' } }))
        .status,
    ).toBe(404);
    expect((await send('DELETE', '/api/entities/events/6')).status).toBe(404);
    expect((await send('DELETE', '/api/entities/events/7')).status).toBe(404);
    expect(await own('events_archive')).toHaveLength(2);
    expect(await own('events_locked')).toHaveLength(2);
  });

  it('deletes exactly the parent row and audits exactly one row', async () => {
    const res = await send('DELETE', '/api/entities/events/5');
    expect(res.status, res.raw).toBe(204);
    expect(await own('events')).toEqual([{ id: 1, name: 'parent-1' }]);
    expect(await own('events_archive')).toEqual([
      { id: 5, name: 'archived-5' },
      { id: 6, name: 'archived-6' },
    ]);
    expect(await own('events_locked')).toEqual([
      { id: 5, name: 'locked-5' },
      { id: 7, name: 'locked-7' },
    ]);
    expect(await auditRows('delete')).toEqual([
      { entity: 'events', record_id: '5', before: { id: 5, name: 'renamed-5' }, after: null },
    ]);
  });

  it('still enforces the child’s own rules when addressed directly', async () => {
    const child = (await send('GET', '/api/entities/events_locked/7')).body as Item;
    expect(child.values).toEqual({ id: 7, name: 'locked-7' });
    expect((await send('DELETE', '/api/entities/events_locked/7')).status).toBe(403);
  });
});
