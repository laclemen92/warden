import { Writable } from 'node:stream';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';

const ACCESS = `
access:
  groups:
    warden-viewers: [viewer]
    warden-editors: [named]
    warden-admins: [star]
`;

// Grants alone, with nothing opting in: the default.
const DEFAULT_CONFIG = `
roles:
  viewer: { grants: { '*': [read] } }
  named: { grants: { users: [delete], companies: [delete], orders: [delete] } }
  star: { grants: { '*': [read, create, update] } }
${ACCESS}`;

const OPT_IN_CONFIG = `
tables:
  users: { allowDelete: true }
  orders: { allowDelete: true, deny: [delete] }
roles:
  viewer: { grants: { '*': [read] } }
  named: { grants: { users: [delete], companies: [delete], orders: [delete] } }
  star: { grants: { '*': [read, create, update] } }
${ACCESS}`;

const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };
type User = 'viewer' | 'editor' | 'admin';
type Warden = Awaited<ReturnType<typeof createWarden>>;

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
}, 120_000);

afterAll(async () => {
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

async function start(config: string) {
  const warnings: [unknown, unknown][] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      const line = JSON.parse(String(chunk)) as { msg?: string; configPath?: string };
      if (String(line.msg).startsWith('config: ')) warnings.push([line.configPath, line.msg]);
      done();
    },
  });
  const app = await createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: writeConfig(config),
      ...authEnv(idp),
    },
    logger: { level: 'warn', stream },
  });
  const cookies = {} as Record<User, string>;
  for (const user of ['viewer', 'editor', 'admin'] as const) {
    cookies[user] = await login(app, user);
  }
  return { app, cookies, warnings };
}

/** A fresh row in `table`, by hand, so deleting it disturbs nothing else. */
async function newRow(table: 'companies' | 'users' | 'orders'): Promise<string> {
  const sql = {
    companies: `insert into companies (name) values ('Doomed') returning id`,
    users: `insert into users (email, password_hash)
      values ('doomed-' || gen_random_uuid() || '@example.com', 'x') returning id`,
    orders: `insert into orders (company_id, total) select id, 1 from companies limit 1 returning id`,
  }[table];
  const { rows } = await sqlPool.query<{ id: string }>(sql);
  return String(rows[0]!.id);
}

const exists = async (table: string, id: string) =>
  (await sqlPool.query(`select 1 from ${table} where id = $1`, [id])).rowCount === 1;

const remove = (app: Warden, cookie: string, table: string, id: string) =>
  app.inject({ method: 'DELETE', url: `/api/entities/${table}/${id}`, headers: { cookie } });

const capabilities = async (app: Warden, cookie: string) =>
  (await app.inject({ method: 'GET', url: '/api/capabilities', headers: { cookie } })).json<{
    entities: Record<string, { actions: string[] }>;
  }>().entities;

describe('with the default config', () => {
  let warden: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    warden = await start(DEFAULT_CONFIG);
  }, 120_000);
  afterAll(() => warden?.app.close());

  it.each(['companies', 'users', 'orders'] as const)(
    'refuses to delete %s for a `*` grant or a named one, as any denied write',
    async (table) => {
      const { app, cookies } = warden;
      const id = await newRow(table);
      for (const user of ['editor', 'admin', 'viewer'] as const) {
        const res = await remove(app, cookies[user], table, id);
        expect(res.statusCode, `${user}: ${res.body}`).toBe(403);
        expect(res.json()).toEqual(FORBIDDEN);
      }
      expect(await exists(table, id)).toBe(true);
    },
  );

  it('offers no delete in capabilities', async () => {
    const { app, cookies } = warden;
    for (const user of ['editor', 'admin'] as const) {
      for (const [entity, { actions }] of Object.entries(await capabilities(app, cookies[user]))) {
        expect(actions, `${user} ${entity}`).not.toContain('delete');
      }
    }
  });

  it('warns at startup about each ignored grant, naming the key to add', () => {
    expect(warden.warnings).toEqual(
      expect.arrayContaining([
        [
          'roles.named.grants.users',
          'config: delete is ignored: hard delete is off for "users"; ' +
            'set tables.users.allowDelete: true to allow it',
        ],
        ['roles.named.grants.companies', expect.stringContaining('tables.companies.allowDelete')],
        ['roles.named.grants.orders', expect.stringContaining('tables.orders.allowDelete')],
      ]),
    );
  });
});

describe('with one table opted in', () => {
  let warden: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    warden = await start(OPT_IN_CONFIG);
  }, 120_000);
  afterAll(() => warden?.app.close());

  it('lets a role granted delete on that table delete there', async () => {
    const { app, cookies } = warden;
    const id = await newRow('users');
    const res = await remove(app, cookies.editor, 'users', id);
    expect(res.statusCode, res.body).toBe(204);
    expect(await exists('users', id)).toBe(false);
  });

  it('never lets a `*` grant delete, even on the opted-in table', async () => {
    const { app, cookies } = warden;
    const id = await newRow('users');
    const res = await remove(app, cookies.admin, 'users', id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN);
    expect(await exists('users', id)).toBe(true);
  });

  it('still refuses tables that did not opt in, and tables that deny delete', async () => {
    const { app, cookies } = warden;
    for (const table of ['companies', 'orders'] as const) {
      const id = await newRow(table);
      const res = await remove(app, cookies.editor, table, id);
      expect(res.statusCode, table).toBe(403);
      expect(res.json()).toEqual(FORBIDDEN);
      expect(await exists(table, id)).toBe(true);
    }
  });

  it('lists delete in capabilities only where it is allowed', async () => {
    const { app, cookies } = warden;
    const editor = await capabilities(app, cookies.editor);
    expect(editor.users?.actions).toEqual(['read', 'delete']);
    expect(editor.companies?.actions).toEqual(['read']);
    expect(editor.orders?.actions).toEqual(['read']);
    expect((await capabilities(app, cookies.admin)).users?.actions).not.toContain('delete');
  });

  it('warns about the deny that overrides the opt-in, and the cascade it allows', () => {
    expect(warden.warnings).toEqual(
      expect.arrayContaining([
        ['tables.orders.allowDelete', 'config: has no effect: the table denies delete'],
        [
          'tables.users',
          'config: deleting a row here also changes rows in "public.orders" (on delete set null), ' +
            "outside Warden's policy and audit log",
        ],
      ]),
    );
    expect(warden.warnings.map(([path]) => path)).not.toContain('roles.named.grants.users');
  });
});
