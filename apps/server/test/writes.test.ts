import { fileURLToPath } from 'node:url';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
);

const FIXTURES = `
  create table order_tags (
    order_id bigint not null references orders (id),
    tag      text not null,
    primary key (order_id, tag)
  );
  insert into order_tags (order_id, tag) values (1, 'gift');
  create table notes (body text);
  create table company_contracts (
    company_id bigint not null references companies (id),
    title      text not null
  );
`;

interface Item {
  id: string | null;
  version?: string;
  values: Record<string, unknown>;
}

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
let admin: string;

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
  admin = await login(app, 'admin');
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
const create = (entity: string, values: object) =>
  send('POST', `/api/entities/${entity}`, { values });
const update = (entity: string, item: Item, values: object, version = item.version) =>
  send('PATCH', `/api/entities/${entity}/${item.id}`, { version, values });
const sqlRow = async (query: string, params: unknown[] = []) =>
  (await sqlPool.query<Record<string, unknown>>(query, params)).rows[0];

// Postgres text for timestamps, as the API returns them.
const companyRow = (id: unknown) =>
  sqlRow('select *, created_at::text as created_at from companies where id = $1', [id]);

const newCompany = async (name: string) => {
  const res = await create('companies', { name });
  expect(res.status, res.raw).toBe(201);
  return res.body as Item;
};

describe('POST /api/entities/:entity', () => {
  it('creates a row and returns it with its id and version', async () => {
    const res = await create('companies', { name: 'Initech', domain: 'initech.test' });
    expect(res.status, res.raw).toBe(201);
    const item = res.body as Item;
    const row = await companyRow(item.id);
    expect(item.values).toEqual(row);
    expect(item.id).toBe(String(row!.id));
    expect(item.version).toEqual(expect.any(String));
    // The version matches what a read returns.
    const read = await send('GET', `/api/entities/companies/${item.id}`);
    expect(read.body).toEqual(item);
  });

  it('rejects read-only columns, configured and identity', async () => {
    const res = await create('users', { email: 'ro@example.com', id: 1, created_at: '2020-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        { field: 'id', message: 'is read-only' },
        { field: 'created_at', message: 'is read-only' },
      ]),
    );
  });

  it('rejects hidden fields exactly like nonexistent ones', async () => {
    const hidden = await create('users', { email: 'h@example.com', password_hash: 'x' });
    const missing = await create('users', { email: 'h@example.com', nonexistent: 'x' });
    expect(hidden.status).toBe(400);
    expect(hidden.body.details).toEqual([
      { field: 'password_hash', message: 'unknown field "password_hash"' },
    ]);
    expect(missing.body.details).toEqual([
      { field: 'nonexistent', message: 'unknown field "nonexistent"' },
    ]);
  });

  it("doesn't name a hidden NOT NULL column the insert is missing", async () => {
    // users.password_hash is hidden, NOT NULL, and has no default.
    const res = await create('users', { email: 'nopw@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ message: 'a required value is missing' }]);
    expect(res.raw).not.toContain('password_hash');
  });

  it('maps constraint violations to field errors', async () => {
    await create('companies', { name: 'A', domain: 'dup.test' });
    const dup = await create('companies', { name: 'B', domain: 'dup.test' });
    expect(dup.status).toBe(409);
    expect(dup.body.details).toEqual([{ field: 'domain', message: 'is already in use' }]);
  });

  it('validates values before they reach the database', async () => {
    const res = await create('companies', { name: 42 });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'name', message: 'expected a string' }]);
    for (const payload of [{}, { values: [] }, { values: 'x' }]) {
      expect((await send('POST', '/api/entities/companies', payload)).status).toBe(400);
    }
  });

  it('keeps SQL in field names and values inert', async () => {
    const name = `x'); drop table companies; --`;
    const item = await newCompany(name);
    expect((await sqlRow('select name from companies where id = $1', [item.id]))?.name).toBe(name);
    const res = await create('companies', { name: 'x', 'name" = 1; --': 'y' });
    expect(res.status).toBe(400);
  });

  it('creates rows in tables without a primary key, with a null id', async () => {
    const res = await create('notes', { body: 'hi' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: null, values: { body: 'hi' } });
  });

  it('404s for hidden or unknown entities', async () => {
    expect((await create('nope', { name: 'x' })).status).toBe(404);
  });
});

describe('PATCH /api/entities/:entity/:id', () => {
  it('updates with the current version and returns a new one', async () => {
    const item = await newCompany('Before');
    const res = await update('companies', item, { name: 'After', plan: 'pro' });
    expect(res.status, res.raw).toBe(200);
    const updated = res.body as Item;
    expect(updated.values).toEqual({ ...item.values, name: 'After', plan: 'pro' });
    expect(updated.version).not.toBe(item.version);
    expect(await companyRow(item.id)).toEqual(updated.values);
  });

  it('returns 409 for a stale version and keeps the newer write', async () => {
    const item = await newCompany('Original');
    expect((await update('companies', item, { name: 'First' })).status).toBe(200);
    const stale = await update('companies', item, { name: 'Second' });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toBe('the record has changed since it was read');
    expect((await sqlRow('select name from companies where id = $1', [item.id]))?.name).toBe(
      'First',
    );
  });

  it('notices changes made outside Warden', async () => {
    const item = await newCompany('Outside');
    await sqlPool.query(`update companies set plan = 'enterprise' where id = $1`, [item.id]);
    expect((await update('companies', item, { name: 'Inside' })).status).toBe(409);
  });

  it('rejects read-only, hidden, and unknown fields', async () => {
    const res = await send('GET', '/api/entities/users/1');
    const user = res.body as Item;
    for (const [values, message] of [
      [{ created_at: '2020-01-01' }, 'is read-only'],
      [{ id: '5' }, 'is read-only'],
      [{ password_hash: 'x' }, 'unknown field "password_hash"'],
    ] as const) {
      const patched = await update('users', user, values);
      expect(patched.status).toBe(400);
      expect(patched.body.details).toEqual([{ field: Object.keys(values)[0], message }]);
    }
    expect((await sqlRow('select password_hash from users where id = 1'))?.password_hash).not.toBe(
      'x',
    );
  });

  it('requires a version and at least one field', async () => {
    const item = await newCompany('Strict');
    const url = `/api/entities/companies/${item.id}`;
    expect((await send('PATCH', url, { values: { name: 'x' } })).status).toBe(400);
    const empty = await send('PATCH', url, { version: item.version, values: {} });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('no fields to update');
  });

  it('maps constraint violations', async () => {
    await create('companies', { name: 'Taken', domain: 'taken.test' });
    const item = await newCompany('Taker');
    const res = await update('companies', item, { domain: 'taken.test' });
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual([{ field: 'domain', message: 'is already in use' }]);

    const order = (await send('GET', '/api/entities/orders/1')).body as Item;
    const fk = await update('orders', order, { company_id: '999999' });
    expect(fk.status).toBe(400);
    expect(fk.body.details).toEqual([
      { field: 'company_id', message: 'references a record that does not exist' },
    ]);
    const check = await update('orders', order, { total: '-1' });
    expect(check.status).toBe(400);
    expect(check.body.details).toEqual([
      { field: 'total', message: 'violates a check constraint' },
    ]);
  });

  it('updates rows with composite keys', async () => {
    const list = (await send('GET', '/api/entities/order_tags')).body as { items: Item[] };
    const tag = list.items[0]!;
    const res = await update('order_tags', tag, { tag: 'rush' });
    expect(res.status, res.raw).toBe(200);
    // Changing a key column changes the id.
    expect((res.body as Item).id).not.toBe(tag.id);
    expect((await send('GET', `/api/entities/order_tags/${(res.body as Item).id}`)).status).toBe(
      200,
    );
  });

  it('404s for missing rows and malformed ids', async () => {
    for (const id of ['999999', 'not-a-number']) {
      const res = await send('PATCH', `/api/entities/companies/${id}`, {
        version: 'v',
        values: { name: 'x' },
      });
      expect(res.status).toBe(404);
    }
  });
});

describe('DELETE /api/entities/:entity/:id', () => {
  it('deletes a row', async () => {
    const item = await newCompany('Doomed');
    const res = await send('DELETE', `/api/entities/companies/${item.id}`);
    expect(res.status).toBe(204);
    expect(await sqlRow('select 1 from companies where id = $1', [item.id])).toBeUndefined();
    expect((await send('GET', `/api/entities/companies/${item.id}`)).status).toBe(404);
    expect((await send('DELETE', `/api/entities/companies/${item.id}`)).status).toBe(404);
  });

  it('checks the version when one is given', async () => {
    const item = await newCompany('Versioned');
    const url = `/api/entities/companies/${item.id}`;
    expect((await send('DELETE', url, { version: 'stale' })).status).toBe(409);
    expect(await sqlRow('select 1 from companies where id = $1', [item.id])).toBeDefined();
    expect((await send('DELETE', url, { version: item.version })).status).toBe(204);
  });

  it('returns 409 when other rows still reference it', async () => {
    const item = await newCompany('Referenced');
    await sqlPool.query(`insert into company_contracts values ($1, 'MSA')`, [item.id]);
    const res = await send('DELETE', `/api/entities/companies/${item.id}`);
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual([{ message: 'is referenced by other records' }]);
    expect(await sqlRow('select 1 from companies where id = $1', [item.id])).toBeDefined();
  });
});

describe('writes and roles', () => {
  it('denies writes the policy does not grant', async () => {
    const viewer = await login(app, 'viewer');
    const item = await newCompany('Guarded');
    expect(
      (await send('POST', '/api/entities/companies', { values: { name: 'x' } }, viewer)).status,
    ).toBe(403);
    expect(
      (
        await send(
          'PATCH',
          `/api/entities/companies/${item.id}`,
          { version: item.version, values: { name: 'x' } },
          viewer,
        )
      ).status,
    ).toBe(403);
    expect(
      (await send('DELETE', `/api/entities/companies/${item.id}`, undefined, viewer)).status,
    ).toBe(403);
    expect((await sqlRow('select name from companies where id = $1', [item.id]))?.name).toBe(
      'Guarded',
    );
  });
});
