import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveSchema, Entity } from '@wardenhq/core';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

const CONFIG = `
tables:
  users:
    displayField: email
    defaultSort: { column: email }
    searchable: [email, full_name]
    columns:
      password_hash: { hidden: true }
      email: { readableBy: [admin] }
      company_id: { readableBy: [admin] }
      role: { writableBy: [admin] }
      metadata: { readableBy: [admin, ops], writableBy: [admin] }
roles:
  viewer: { grants: { '*': [read] } }
  ops: { grants: { '*': [read], users: [read, create, update] } }
  admin: { grants: { '*': [read, create, update, delete] } }
access:
  groups:
    warden-viewers: [viewer]
    warden-editors: [ops]
    warden-admins: [admin]
`;

type User = 'viewer' | 'editor' | 'admin';
interface Item {
  id: string;
  version: string;
  values: Record<string, unknown>;
}

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
const cookies = {} as Record<User, string>;

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  const dir = mkdtempSync(join(tmpdir(), 'warden-fields-'));
  const config = join(dir, 'warden.config.yaml');
  writeFileSync(config, CONFIG);
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: config, ...authEnv(idp) },
  });
  for (const user of ['viewer', 'editor', 'admin'] as const) {
    cookies[user] = await login(app, user);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const send = async (user: User, method: string, url: string, payload?: object) => {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: cookies[user] },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined, raw: res.body };
};
const list = async (user: User, query: Record<string, string> = {}) => {
  const res = await send(user, 'GET', `/api/entities/users?${new URLSearchParams(query)}`);
  return res;
};
const getUser = async (user: User, id = '1') =>
  (await send(user, 'GET', `/api/entities/users/${id}`)).body as Item;
const usersIn = async (user: User) => {
  const schema = (await send(user, 'GET', '/api/schema')).body as EffectiveSchema;
  return {
    users: schema.entities.find((e) => e.key === 'users')!,
    companies: schema.entities.find((e) => e.key === 'companies')!,
  };
};
const fieldNames = (entity: Entity) => entity.fields.map((f) => f.name);
const latestAudit = async () =>
  (
    await sqlPool.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      'select before, after from warden.audit_log order by id desc limit 1',
    )
  ).rows[0];

const ALL = [
  'id',
  'company_id',
  'email',
  'full_name',
  'role',
  'is_active',
  'metadata',
  'last_login_at',
  'created_at',
];
const VISIBLE: Record<User, string[]> = {
  admin: ALL,
  editor: ALL.filter((f) => f !== 'email' && f !== 'company_id'),
  viewer: ALL.filter((f) => f !== 'email' && f !== 'company_id' && f !== 'metadata'),
};

describe('reading', () => {
  it.each(Object.entries(VISIBLE))('returns only the fields %s may read', async (user, fields) => {
    const listed = await list(user as User, { limit: '5' });
    expect(listed.status, listed.raw).toBe(200);
    for (const item of (listed.body as { items: Item[] }).items) {
      expect(Object.keys(item.values)).toEqual(fields);
    }
    expect(Object.keys((await getUser(user as User)).values)).toEqual(fields);
  });

  it('serves each user their own schema', async () => {
    const editor = await usersIn('editor');
    expect(fieldNames(editor.users)).toEqual(VISIBLE.editor);
    expect(editor.users.fields.find((f) => f.name === 'role')?.readOnly).toBe(true);
    expect(editor.users.fields.find((f) => f.name === 'metadata')?.readOnly).toBe(true);
    expect(editor.users.fields.find((f) => f.name === 'full_name')?.readOnly).toBe(false);
    expect(editor.users).toMatchObject({ displayField: 'id', searchable: ['full_name'] });
    expect(editor.users.defaultSort).toBeUndefined();
    expect(editor.users.relations.map((r) => r.name)).not.toContain('users_company_id_fkey');
    expect(editor.companies.relations.map((r) => r.name)).not.toContain('users_company_id_fkey');
    expect(JSON.stringify(editor)).not.toContain('readableBy');

    const admin = await usersIn('admin');
    expect(fieldNames(admin.users)).toEqual(ALL);
    expect(admin.users).toMatchObject({ displayField: 'email', defaultSort: { column: 'email' } });
    expect(admin.users.relations.map((r) => r.name)).toContain('users_company_id_fkey');
  });

  it('rejects filtering and sorting on unreadable fields exactly like nonexistent ones', async () => {
    const filterOn = (field: string) =>
      list('editor', { filter: JSON.stringify({ field, op: 'eq', value: 'x' }) });
    const [unreadable, missing] = [await filterOn('email'), await filterOn('nope')];
    expect(unreadable.status).toBe(400);
    expect(unreadable.raw).toBe(missing.raw.replaceAll('nope', 'email'));

    const [sortUnreadable, sortMissing] = [
      await list('editor', { sort: 'email' }),
      await list('editor', { sort: 'nope' }),
    ];
    expect(sortUnreadable.status).toBe(400);
    expect(sortUnreadable.raw).toBe(sortMissing.raw.replaceAll('nope', 'email'));

    // So values can't be probed one comparison at a time.
    expect((await filterOn('company_id')).status).toBe(400);
    expect((await list('admin', { sort: 'email' })).status).toBe(200);
  });

  it("doesn't search fields the user can't read", async () => {
    const q = 'user7@company8.example';
    const admin = (await list('admin', { q })).body as { items: Item[] };
    expect(admin.items.map((i) => i.values.email)).toEqual([q]);
    expect(((await list('editor', { q })).body as { items: Item[] }).items).toEqual([]);
  });
});

describe('writing', () => {
  it('rejects unwritable fields as read-only and unreadable ones as unknown', async () => {
    const user = await getUser('editor');
    const patch = (values: object) =>
      send('editor', 'PATCH', '/api/entities/users/1', { version: user.version, values });
    for (const [values, details] of [
      [{ role: 'admin' }, [{ field: 'role', message: 'is read-only' }]],
      [{ metadata: {} }, [{ field: 'metadata', message: 'is read-only' }]],
      [{ email: 'x@example.com' }, [{ field: 'email', message: 'unknown field "email"' }]],
      [{ company_id: '2' }, [{ field: 'company_id', message: 'unknown field "company_id"' }]],
    ] as const) {
      const res = await patch(values);
      expect(res.status, JSON.stringify(values)).toBe(400);
      expect(res.body.details).toEqual(details);
    }
    const created = await send('editor', 'POST', '/api/entities/users', {
      values: { full_name: 'New', email: 'new@example.com' },
    });
    expect(created.status).toBe(400);
    expect(created.body.details).toEqual([{ field: 'email', message: 'unknown field "email"' }]);
  });

  it('lets a role that may write the field change it', async () => {
    const user = await getUser('admin', '2');
    const res = await send('admin', 'PATCH', '/api/entities/users/2', {
      version: user.version,
      values: { role: 'owner', metadata: { vip: true } },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.values).toMatchObject({ role: 'owner', metadata: { vip: true } });
  });

  it('returns only readable fields from a write, but audits the whole row', async () => {
    const user = await getUser('editor', '3');
    const res = await send('editor', 'PATCH', '/api/entities/users/3', {
      version: user.version,
      values: { full_name: 'Edited by ops' },
    });
    expect(res.status, res.raw).toBe(200);
    expect(Object.keys(res.body.values)).toEqual(VISIBLE.editor);
    const entry = await latestAudit();
    expect(entry?.after).toMatchObject({ full_name: 'Edited by ops', email: expect.any(String) });
    expect(entry?.before).toHaveProperty('company_id');
  });

  it("doesn't name an unreadable NOT NULL column a create is missing", async () => {
    const res = await send('editor', 'POST', '/api/entities/users', {
      values: { full_name: 'No email' },
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ message: 'a required value is missing' }]);
    expect(res.raw).not.toContain('email');
  });

  it('versions each user by the fields they can see', async () => {
    const [asEditor, asAdmin] = [await getUser('editor', '4'), await getUser('admin', '4')];
    expect(asEditor.version).not.toBe(asAdmin.version);

    const roleChange = await send('admin', 'PATCH', '/api/entities/users/4', {
      version: asAdmin.version,
      values: { role: 'admin' },
    });
    expect(roleChange.status).toBe(200);
    // role is visible to the editor, so an admin changing it makes the editor's version stale.
    expect(
      (
        await send('editor', 'PATCH', '/api/entities/users/4', {
          version: asEditor.version,
          values: { full_name: 'x' },
        })
      ).status,
    ).toBe(409);

    // A change to a field the editor can't see doesn't.
    const fresh = await getUser('editor', '4');
    await sqlPool.query(`update users set email = 'changed@example.com' where id = 4`);
    const res = await send('editor', 'PATCH', '/api/entities/users/4', {
      version: fresh.version,
      values: { full_name: 'Still current' },
    });
    expect(res.status, res.raw).toBe(200);
    // The admin's view includes email, so their old version is stale.
    const stale = await send('admin', 'PATCH', '/api/entities/users/4', {
      version: (roleChange.body as Item).version,
      values: { full_name: 'y' },
    });
    expect(stale.status).toBe(409);
  });
});
