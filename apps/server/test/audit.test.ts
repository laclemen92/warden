import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_REASON_LENGTH } from '../src/routes/entities.js';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';
import { exampleConfigDeletingCompanies } from './helpers/config.js';

// Deleting companies needs allowDelete, which the example only sets on users.
const CONFIG = exampleConfigDeletingCompanies();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
let editor: string;
let viewer: string;

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: CONFIG, ...authEnv(idp) },
  });
  [admin, editor, viewer] = [
    await login(app, 'admin'),
    await login(app, 'editor'),
    await login(app, 'viewer'),
  ];
  // Fails the audit insert on demand, standing in for a full disk or revoked grant.
  await sqlPool.query(`
    create function fail_audit() returns trigger language plpgsql as $$
      begin raise exception 'audit storage unavailable'; end; $$;
    create trigger fail_audit before insert on warden.audit_log
      for each row when (new.reason = 'fail the audit') execute function fail_audit();
  `);
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
const entries = async (where = 'true', params: unknown[] = []) =>
  (
    await sqlPool.query<Record<string, unknown>>(
      `select request_id, actor_subject, actor_email, actor_roles, action, entity, record_id,
              primary_key, before, after, diff, reason, occurred_at
       from warden.audit_log where ${where} order by id`,
      params,
    )
  ).rows;
const latest = async () => (await entries()).at(-1);
const count = async () => (await entries()).length;

const newCompany = async (name: string, extra: object = {}) => {
  const res = await send('POST', '/api/entities/companies', { values: { name }, ...extra });
  expect(res.status, res.raw).toBe(201);
  return res.body as Item;
};

describe('audit entries for writes', () => {
  it('records a create with actor, roles, request id, and reason', async () => {
    const item = await newCompany('Audited', { reason: '  onboarding  ' });
    expect(await latest()).toEqual({
      request_id: expect.stringMatching(UUID),
      actor_subject: 'admin',
      actor_email: 'admin@example.com',
      // example.com addresses also get viewer from the email-domain rule.
      actor_roles: ['admin', 'viewer'],
      action: 'create',
      entity: 'companies',
      record_id: item.id,
      primary_key: { id: item.id },
      before: null,
      after: item.values,
      diff: Object.fromEntries(
        Object.entries(item.values).map(([k, v]) => [k, { from: null, to: v }]),
      ),
      reason: 'onboarding',
      occurred_at: expect.any(Date),
    });
  });

  it('records an update with before, after, and the changed fields', async () => {
    const item = await newCompany('Before');
    const res = await send(
      'PATCH',
      `/api/entities/companies/${item.id}`,
      { version: item.version, values: { name: 'After', plan: 'free' }, reason: 'rename' },
      editor,
    );
    expect(res.status, res.raw).toBe(200);
    expect(await latest()).toMatchObject({
      actor_subject: 'editor',
      actor_roles: ['ops', 'viewer'],
      action: 'update',
      record_id: item.id,
      before: item.values,
      after: (res.body as Item).values,
      // plan was already 'free', so it isn't a change.
      diff: { name: { from: 'Before', to: 'After' } },
      reason: 'rename',
    });
  });

  it('records a delete, with or without a body', async () => {
    const first = await newCompany('Gone');
    expect((await send('DELETE', `/api/entities/companies/${first.id}`)).status).toBe(204);
    expect(await latest()).toMatchObject({
      action: 'delete',
      record_id: first.id,
      before: first.values,
      after: null,
      reason: null,
    });

    const second = await newCompany('Gone too');
    const res = await send('DELETE', `/api/entities/companies/${second.id}`, {
      version: second.version,
      reason: 'duplicate',
    });
    expect(res.status).toBe(204);
    expect(await latest()).toMatchObject({ action: 'delete', reason: 'duplicate' });
  });

  it('gives each request its own id', async () => {
    await newCompany('One');
    await newCompany('Two');
    const [a, b] = (await entries()).slice(-2);
    expect(a!.request_id).not.toBe(b!.request_id);
  });

  it('stores a blank reason as none', async () => {
    await newCompany('Blank', { reason: '   ' });
    expect((await latest())!.reason).toBeNull();
  });

  it('rejects an oversized reason', async () => {
    const before = await count();
    const res = await send('POST', '/api/entities/companies', {
      values: { name: 'Long' },
      reason: 'x'.repeat(MAX_REASON_LENGTH + 1),
    });
    expect(res.status).toBe(400);
    expect(await count()).toBe(before);
  });

  it('never records hidden columns', async () => {
    const user = (await send('GET', '/api/entities/users/1')).body as Item;
    const res = await send('PATCH', '/api/entities/users/1', {
      version: user.version,
      values: { full_name: 'Renamed' },
    });
    expect(res.status, res.raw).toBe(200);
    const entry = await latest();
    expect(entry!.before).not.toHaveProperty('password_hash');
    expect(JSON.stringify(entry)).not.toContain('password_hash');
    const { rows } = await sqlPool.query<{ password_hash: string }>(
      'select password_hash from users where id = 1',
    );
    expect(JSON.stringify(entry)).not.toContain(rows[0]!.password_hash);
  });

  it('writes nothing for writes that are denied, invalid, stale, or fail', async () => {
    const item = await newCompany('Untouched');
    const before = await count();
    const url = `/api/entities/companies/${item.id}`;
    expect(
      (await send('PATCH', url, { version: item.version, values: { name: 'x' } }, viewer)).status,
    ).toBe(403);
    expect((await send('PATCH', url, { version: item.version, values: { id: '1' } })).status).toBe(
      400,
    );
    expect((await send('PATCH', url, { version: 'stale', values: { name: 'x' } })).status).toBe(
      409,
    );
    expect((await send('DELETE', '/api/entities/companies/999999')).status).toBe(404);
    await send('POST', '/api/entities/companies', { values: { name: 'A', domain: 'taken.test' } });
    const afterSetup = await count();
    expect(
      (
        await send('POST', '/api/entities/companies', {
          values: { name: 'B', domain: 'taken.test' },
        })
      ).status,
    ).toBe(409);
    expect(afterSetup).toBe(before + 1);
    expect(await count()).toBe(afterSetup);
  });
});

describe('when the audit insert fails', () => {
  const FAIL = { reason: 'fail the audit' };
  const INTERNAL = {
    statusCode: 500,
    error: 'Internal Server Error',
    message: 'Internal Server Error',
  };
  const companyNames = async () =>
    (await sqlPool.query<{ name: string }>('select name from companies')).rows.map((r) => r.name);

  it('rolls back a create', async () => {
    const before = await count();
    const res = await send('POST', '/api/entities/companies', {
      values: { name: 'Unaudited create' },
      ...FAIL,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL);
    expect(await companyNames()).not.toContain('Unaudited create');
    expect(await count()).toBe(before);
  });

  it('rolls back an update', async () => {
    const item = await newCompany('Stable');
    const res = await send('PATCH', `/api/entities/companies/${item.id}`, {
      version: item.version,
      values: { name: 'Unaudited update' },
      ...FAIL,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL);
    expect(await companyNames()).toContain('Stable');
    expect(await companyNames()).not.toContain('Unaudited update');
    // The version still matches, so nothing changed.
    const retry = await send('PATCH', `/api/entities/companies/${item.id}`, {
      version: item.version,
      values: { name: 'Audited update' },
    });
    expect(retry.status).toBe(200);
  });

  it('rolls back a delete', async () => {
    const item = await newCompany('Survivor');
    const res = await send('DELETE', `/api/entities/companies/${item.id}`, FAIL);
    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL);
    expect((await send('GET', `/api/entities/companies/${item.id}`)).status).toBe(200);
  });
});
