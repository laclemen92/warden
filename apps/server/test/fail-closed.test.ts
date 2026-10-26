import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';

type App = Awaited<ReturnType<typeof createWarden>>;

const SCHEMA = `
  create table staff (id bigint primary key, email text not null, name text);
  insert into staff values (101, 'admin@example.com', 'Ada'), (102, 'editor@example.com', 'Ed');

  -- Soft delete configured on columns that were dropped, renamed, or are hidden.
  create table gone (id serial primary key, name text, deleted_at timestamptz);
  alter table gone drop column deleted_at;
  create table renamed (id serial primary key, name text, deleted_at timestamptz);
  alter table renamed rename column deleted_at to removed_at;
  create table masked (id serial primary key, name text, deleted_at timestamptz);
`;

const ACCESS = `
access:
  groups:
    warden-viewers: [admin]
    warden-editors: [admin]
    warden-admins: [admin]
`;

const CONFIG = `
defaults: { requireReason: [] }
tables:
  gone: { allowDelete: true, softDelete: { column: deleted_at } }
  renamed: { allowDelete: true, softDelete: { column: deleted_at } }
actor: { table: staff, matchColumn: email, idColumn: id }
roles:
  admin:
    grants:
      '*': [read, create, update]
      gone: [delete]
      renamed: [delete]
    actions: ['*']
${ACCESS}`;

// Hidden by newColumns, since config refuses \`hidden\` on a soft delete column. Hard delete is on
// everywhere through defaults.delete.
const HIDDEN_CONFIG = `
defaults: { requireReason: [], newColumns: hidden, delete: granted }
tables:
  masked: { softDelete: { column: deleted_at }, columns: { name: {} } }
roles:
  admin: { grants: { '*': [read], masked: [delete] } }
${ACCESS}`;

const ACTIONS_MODULE = `
export default ({ defineAction, z }) => [
  defineAction({
    name: 'set-staff',
    label: 'Set staff',
    on: 'staff',
    target: 'none',
    confirm: 'confirm',
    requireReason: false,
    permissions: { staff: ['create', 'update'] },
    input: z.object({ how: z.enum(['email', 'id', 'create']) }),
    async run({ tx, input }) {
      if (input.how === 'email') await tx.update('staff', '102', { email: 'admin@example.com' });
      if (input.how === 'id') await tx.update('staff', '102', { id: 101 });
      if (input.how === 'create') await tx.create('staff', { id: 103, email: 'new@example.com' });
      return { message: 'done' };
    },
  }),
  defineAction({
    name: 'purge-gone',
    label: 'Purge',
    on: 'gone',
    target: 'none',
    confirm: 'confirm',
    requireReason: false,
    permissions: { gone: ['delete'] },
    input: z.object({ id: z.string() }),
    async run({ tx, input }) {
      await tx.delete('gone', input.id);
      return { message: 'purged' };
    },
  }),
];
`;

const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let actionsPath: string;

const start = (config: string, warnings: [unknown, unknown][]) =>
  createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: writeConfig(config),
      WARDEN_ACTIONS: actionsPath,
      ...authEnv(idp),
    },
    logger: {
      level: 'warn',
      stream: new Writable({
        write(chunk, _encoding, done) {
          const line = JSON.parse(String(chunk)) as { msg?: string; configPath?: string };
          if (String(line.msg).startsWith('config: ')) warnings.push([line.configPath, line.msg]);
          done();
        },
      }),
    },
  });

beforeAll(async () => {
  db = await startPostgres({ sql: [SCHEMA] });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  const dir = mkdtempSync(join(tmpdir(), 'warden-fail-closed-'));
  actionsPath = join(dir, 'actions.mjs');
  writeFileSync(actionsPath, ACTIONS_MODULE);
}, 120_000);

afterAll(async () => {
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const staff = async () =>
  (await sqlPool.query('select id, email from staff order by id')).rows as {
    id: string;
    email: string;
  }[];
const ORIGINAL_STAFF = [
  { id: '101', email: 'admin@example.com' },
  { id: '102', email: 'editor@example.com' },
];
const insert = async (sql: string) =>
  String((await sqlPool.query<{ id: number }>(`${sql} returning id`)).rows[0]!.id);
const exists = async (table: string, id: string) =>
  (await sqlPool.query(`select 1 from ${table} where id = $1`, [id])).rowCount === 1;

describe('with a configured actor mapping and unusable soft deletes', () => {
  let app: App;
  let cookie: string;
  const warnings: [unknown, unknown][] = [];

  beforeAll(async () => {
    app = await start(CONFIG, warnings);
    cookie = await login(app, 'admin');
  });

  afterAll(async () => {
    await app?.close();
  });

  const send = (method: string, url: string, payload?: object) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { cookie },
      ...(payload ? { payload } : {}),
    });

  it('shows the actor columns read-only in the schema', async () => {
    const res = await send('GET', '/api/schema');
    const entities = res.json<{
      entities: { key: string; fields: { name: string; readOnly: boolean; createOnly?: true }[] }[];
    }>().entities;
    const fields = entities.find((e) => e.key === 'staff')!.fields;
    expect(fields).toEqual([
      expect.objectContaining({ name: 'id', readOnly: true }),
      expect.objectContaining({ name: 'email', readOnly: true }),
      expect.objectContaining({ name: 'name', readOnly: false }),
    ]);
    expect(fields.find((f) => f.name === 'id')).not.toHaveProperty('createOnly');
  });

  it('refuses writing the actor columns through create and update', async () => {
    const record = await send('GET', '/api/entities/staff/102');
    expect(record.statusCode, record.body).toBe(200);
    const { version } = record.json<{ version: string }>();
    for (const values of [
      { email: 'admin@example.com' },
      { id: 101 },
      { name: 'Eve', email: 'admin@example.com' },
    ]) {
      const res = await send('PATCH', '/api/entities/staff/102', { version, values });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain('is read-only');
    }
    for (const values of [
      { id: 103, email: 'new@example.com' },
      { email: 'new@example.com' },
      { id: 103 },
    ]) {
      const res = await send('POST', '/api/entities/staff', { values });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain('is read-only');
    }
    expect(await staff()).toEqual(ORIGINAL_STAFF);

    // Other columns stay writable.
    const renamed = await send('PATCH', '/api/entities/staff/102', {
      version,
      values: { name: 'Edward' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it("refuses writing the actor columns through a custom action's tx", async () => {
    for (const how of ['email', 'id', 'create']) {
      const res = await send('POST', '/api/actions/set-staff/run', { input: { how } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ message: 'invalid staff values' });
    }
    expect(await staff()).toEqual(ORIGINAL_STAFF);
  });

  it('denies delete where the soft delete column was dropped or renamed', async () => {
    for (const table of ['gone', 'renamed']) {
      const id = await insert(`insert into ${table} (name) values ('kept')`);
      const res = await send('DELETE', `/api/entities/${table}/${id}`, {});
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toEqual(FORBIDDEN);
      expect(await exists(table, id)).toBe(true);
    }
    const capabilities = await send('GET', '/api/capabilities');
    const { entities } = capabilities.json<{ entities: Record<string, { actions: string[] }> }>();
    expect(entities.gone?.actions).not.toContain('delete');
    expect(entities.renamed?.actions).not.toContain('delete');
  });

  it('warns at startup why delete is denied', () => {
    const message = 'soft delete is off for this table, and roles may not delete its rows';
    expect(warnings).toContainEqual([
      'tables.gone.softDelete.column',
      `config: column "deleted_at" does not exist; ${message}`,
    ]);
    expect(warnings).toContainEqual([
      'tables.renamed.softDelete.column',
      `config: column "deleted_at" does not exist; ${message}`,
    ]);
  });

  it("lets a custom action's hard delete follow allowDelete", async () => {
    const id = await insert(`insert into gone (name) values ('purged')`);
    const res = await send('POST', '/api/actions/purge-gone/run', { input: { id } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await exists('gone', id)).toBe(false);
  });
});

describe('a soft delete column hidden by newColumns, with defaults.delete granted', () => {
  let app: App;
  let cookie: string;
  const warnings: [unknown, unknown][] = [];

  beforeAll(async () => {
    app = await start(HIDDEN_CONFIG, warnings);
    cookie = await login(app, 'admin');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('denies delete, with a warning', async () => {
    const id = await insert(`insert into masked (name) values ('kept')`);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/entities/masked/${id}`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN);
    expect(await exists('masked', id)).toBe(true);
    expect(warnings).toContainEqual([
      'tables.masked.softDelete.column',
      'config: column "deleted_at" is not visible; soft delete is off for this table, and roles may not delete its rows',
    ]);
  });
});
