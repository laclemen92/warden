import type { EffectiveSchema } from '@wardenhq/core';
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
    warden-admins: [admin]
`;
const ROLES = `
roles:
  viewer: { grants: { '*': [read] } }
  admin:
    grants: { '*': [read, create, update], companies: [delete], users: [delete], notes: [delete] }
`;

// No `defaults.requireReason`: every write needs a reason, unless the table says otherwise.
const CONFIG = `
tables:
  companies:
    allowDelete: true
  users:
    columns:
      password_hash: { hidden: true }
    requireReason: [delete]
    allowDelete: true
  orders:
    requireReason: [update]
    deny: [update]
  notes:
    requireReason: []
    allowDelete: true
  secrets:
    hidden: true
${ROLES}${ACCESS}`;

// Reasons off by default; one table opts back in.
const OPT_OUT_CONFIG = `
defaults: { requireReason: [], reasonMinLength: 4 }
tables:
  companies:
    allowDelete: true
  notes:
    requireReason: [create]
    allowDelete: true
${ROLES}${ACCESS}`;

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
const TOO_SHORT = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'a reason of at least 10 characters is required for this change',
};
const REASON = 'cleaning up test data';

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;

beforeAll(async () => {
  db = await startPostgres({
    sql: [
      await readExampleSql('basic/schema.sql'),
      await readExampleSql('basic/seed.sql'),
      'create table secrets (id serial primary key, value text)',
      'create table notes (id serial primary key, body text)',
    ],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
}, 120_000);

afterAll(async () => {
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const auditCount = async () =>
  Number((await sqlPool.query('select count(*) from warden.audit_log')).rows[0].count);

/** A Warden on the shared database with `config`, and an admin and a viewer signed in. */
function withWarden(config: string) {
  const state = {} as {
    app: Awaited<ReturnType<typeof createWarden>>;
    admin: string;
    viewer: string;
  };
  beforeAll(async () => {
    state.app = await createWarden({
      env: {
        DATABASE_URL: db.connectionString,
        WARDEN_CONFIG: writeConfig(config),
        ...authEnv(idp),
      },
    });
    state.admin = await login(state.app, 'admin');
    state.viewer = await login(state.app, 'viewer');
  }, 120_000);
  afterAll(() => state.app?.close());

  const send = async (method: string, url: string, payload?: object, cookie = state.admin) => {
    const res = await state.app.inject({
      method: method as 'GET',
      url,
      headers: { cookie },
      ...(payload ? { payload } : {}),
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined, raw: res.body };
  };
  const create = async (entity: string, values: object, reason?: string) => {
    const res = await send('POST', `/api/entities/${entity}`, {
      values,
      ...(reason !== undefined ? { reason } : {}),
    });
    expect(res.status, res.raw).toBe(201);
    return res.body as Item;
  };
  return { state, send, create };
}

describe('required reasons, by default', () => {
  const { state, send, create } = withWarden(CONFIG);

  it('tells the UI which writes need one, and how long it must be', async () => {
    const { entities } = (await send('GET', '/api/schema')).body as EffectiveSchema;
    const byKey = Object.fromEntries(
      entities.map((e) => [e.key, [e.requireReason, e.reasonMinLength]]),
    );
    expect(byKey).toEqual({
      companies: [['create', 'update', 'delete'], 10],
      users: [['delete'], 10],
      orders: [['update'], 10],
      notes: [undefined, undefined],
    });
  });

  it.each([
    ['missing', undefined, REQUIRED],
    ['empty', '', REQUIRED],
    ['only whitespace', '   \n\t', REQUIRED],
    ['too short', 'fix', TOO_SHORT],
    ['too short once trimmed', `   ${'x'.repeat(9)}   `, TOO_SHORT],
  ])(
    'rejects a create, update, or delete whose reason is %s, writing nothing',
    async (how, r, err) => {
      const item = await create('companies', { name: `Needs reasons: ${how}` }, REASON);
      const url = `/api/entities/companies/${item.id}`;
      const before = await auditCount();
      const extra = r === undefined ? {} : { reason: r };

      const created = await send('POST', '/api/entities/companies', {
        values: { name: 'No reason' },
        ...extra,
      });
      expect(created).toMatchObject({ status: 400, body: err });
      const updated = await send('PATCH', url, {
        version: item.version,
        values: { name: 'x' },
        ...extra,
      });
      expect(updated).toMatchObject({ status: 400, body: err });
      const deleted = await send('DELETE', url, { version: item.version, ...extra });
      expect(deleted).toMatchObject({ status: 400, body: err });

      expect(await auditCount()).toBe(before);
      const rows = await sqlPool.query('select name from companies where id = $1', [item.id]);
      expect(rows.rows).toEqual([{ name: `Needs reasons: ${how}` }]);
      expect(
        (await sqlPool.query("select 1 from companies where name = 'No reason'")).rowCount,
      ).toBe(0);
    },
  );

  it('rejects a bare DELETE, which has no body at all', async () => {
    const item = await create('companies', { name: 'Bare delete' }, REASON);
    expect(await send('DELETE', `/api/entities/companies/${item.id}`)).toMatchObject({
      status: 400,
      body: REQUIRED,
    });
  });

  it('rejects a reason over 2,000 characters, required or not', async () => {
    const long = 'x'.repeat(2001);
    for (const entity of ['companies', 'notes']) {
      const res = await send('POST', `/api/entities/${entity}`, {
        values: entity === 'notes' ? { body: 'long' } : { name: 'Long' },
        reason: long,
      });
      expect(res.status, entity).toBe(400);
    }
    expect((await sqlPool.query("select 1 from companies where name = 'Long'")).rowCount).toBe(0);
    expect((await sqlPool.query("select 1 from notes where body = 'long'")).rowCount).toBe(0);
    // Exactly the maximum is fine.
    await create('companies', { name: 'Longest' }, 'x'.repeat(2000));
  });

  it('accepts the write with a long enough reason and records it, trimmed', async () => {
    const item = await create('companies', { name: 'Has reasons' }, 'setting up the account');
    const url = `/api/entities/companies/${item.id}`;
    const updated = await send('PATCH', url, {
      version: item.version,
      values: { name: 'Renamed' },
      reason: '  typo in the name  ',
    });
    expect(updated.status, updated.raw).toBe(200);
    const deleted = await send('DELETE', url, {
      version: (updated.body as Item).version,
      reason: 'x'.repeat(10),
    });
    expect(deleted.status, deleted.raw).toBe(204);
    const { rows } = await sqlPool.query(
      'select action, reason from warden.audit_log where record_id = $1 order by id',
      [item.id],
    );
    expect(rows).toEqual([
      { action: 'create', reason: 'setting up the account' },
      { action: 'update', reason: 'typo in the name' },
      { action: 'delete', reason: 'x'.repeat(10) },
    ]);
  });

  it("lets a table's list narrow the default", async () => {
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

  it('lets a table turn it off with an empty list, keeping an optional reason', async () => {
    const note = await create('notes', { body: 'first' });
    const url = `/api/entities/notes/${note.id}`;
    const updated = await send('PATCH', url, { version: note.version, values: { body: 'b' } });
    expect(updated.status, updated.raw).toBe(200);
    // A short optional reason is fine, and recorded.
    const deleted = await send('DELETE', url, { reason: ' dupe ' });
    expect(deleted.status, deleted.raw).toBe(204);
    const { rows } = await sqlPool.query(
      "select action, reason from warden.audit_log where entity = 'notes' and record_id = $1 order by id",
      [note.id],
    );
    expect(rows).toEqual([
      { action: 'create', reason: null },
      { action: 'update', reason: null },
      { action: 'delete', reason: 'dupe' },
    ]);
  });

  it('checks permissions and existence first', async () => {
    // Denied by role or by the table: 403, whether or not a reason was given.
    const denied = await send('POST', '/api/entities/companies', { values: {} }, state.viewer);
    expect(denied.status).toBe(403);
    expect((await send('PATCH', '/api/entities/orders/1', { values: {} })).status).toBe(403);
    // A hidden table 404s like a nonexistent one, its reason requirement notwithstanding.
    const hidden = await send('POST', '/api/entities/secrets', { values: {} });
    const missing = await send('POST', '/api/entities/nonexistent', { values: {} });
    expect(hidden).toEqual(missing);
    expect(hidden.status).toBe(404);
  });
});

describe('with defaults.requireReason: []', () => {
  const { send, create } = withWarden(OPT_OUT_CONFIG);

  it('makes reasons optional, as before', async () => {
    const item = await create('companies', { name: 'Optional reasons' });
    const url = `/api/entities/companies/${item.id}`;
    const updated = await send('PATCH', url, {
      version: item.version,
      values: { name: 'Still optional' },
      reason: '  ',
    });
    expect(updated.status, updated.raw).toBe(200);
    expect((await send('DELETE', url)).status).toBe(204);
  });

  it("lets a table's list require one anyway, with the configured minimum", async () => {
    const { entities } = (await send('GET', '/api/schema')).body as EffectiveSchema;
    expect(entities.find((e) => e.key === 'notes')).toMatchObject({
      requireReason: ['create'],
      reasonMinLength: 4,
    });
    expect(entities.find((e) => e.key === 'companies')).not.toHaveProperty('requireReason');

    const before = await auditCount();
    for (const reason of [undefined, '   ', 'abc']) {
      const res = await send('POST', '/api/entities/notes', {
        values: { body: 'needs one' },
        ...(reason !== undefined ? { reason } : {}),
      });
      expect(res.status, String(reason)).toBe(400);
    }
    expect(await auditCount()).toBe(before);
    await create('notes', { body: 'has one' }, 'abcd');
  });
});
