import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { MOCK_USERS, type MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionsError } from '../src/actions.js';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';

const ACTIONS = fileURLToPath(new URL('./fixtures/actions.js', import.meta.url));
const EXAMPLE_ACTIONS = fileURLToPath(
  new URL('../../../examples/basic/actions/index.js', import.meta.url),
);
const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
);

const CONFIG = `
defaults: { read: granted }
tables:
  users:
    columns:
      password_hash: { hidden: true }
      last_login_at: { readableBy: [admin] }
  orders:
    deny: [create, delete]
  secrets: { hidden: true }
roles:
  viewer: { grants: { '*': [read] } }
  ops:
    grants: { users: [read], companies: [read] }
    actions:
      [move-user, fail-after-write, rename-companies, peek, purge-orders, switched-off, stamp-login]
  admin:
    grants: { '*': [read, create, update, delete] }
    admin: [audit]
    actions: ['*']
  auditor:
    grants: { users: [read] }
    admin: [audit]
actions:
  switched-off: { disabled: true }
  rename-companies: { requireReason: true, label: Add a suffix }
access:
  groups:
    warden-viewers: [viewer]
    warden-editors: [ops]
    warden-admins: [admin]
    warden-auditors: [auditor]
`;

const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'Not Found' };
const SERVER_ERROR = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
let admin: string;
let ops: string;
let viewer: string;
let auditor: string;
const logLines: Record<string, unknown>[] = [];

beforeAll(async () => {
  db = await startPostgres({
    sql: [
      await readExampleSql('basic/schema.sql'),
      await readExampleSql('basic/seed.sql'),
      'create table secrets (id serial primary key, value text)',
    ],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp({
    users: [...MOCK_USERS, { sub: 'auditor', name: 'Audrey Auditor', groups: ['warden-auditors'] }],
  });
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logLines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  app = await createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: writeConfig(CONFIG),
      WARDEN_ACTIONS: ACTIONS,
      ...authEnv(idp),
    },
    logger: { level: 'info', stream },
  });
  admin = await login(app, 'admin');
  ops = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  auditor = await login(app, 'auditor');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

// What the fixture's `afterCommit` callbacks did (see fixtures/actions.js).
const effectList = () =>
  (globalThis as { __wardenActionEffects?: string[] }).__wardenActionEffects ?? [];
beforeEach(() => void effectList().splice(0));

const send = async (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) => {
  const res = await app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined, raw: res.body };
};
const run = (name: string, body: object, cookie = ops) =>
  send('POST', `/api/actions/${name}/run`, cookie, body);
const preview = (name: string, body: object, cookie = ops) =>
  send('POST', `/api/actions/${name}/preview`, cookie, body);
const query = async (text: string, params: unknown[] = []) =>
  (await sqlPool.query<Record<string, unknown>>(text, params)).rows;
const auditCount = async () =>
  Number((await query('select count(*) as n from warden.audit_log'))[0]!.n);

/** A user whose company we know, moved back to company 1 so every test starts the same. */
async function resetUser(id: number) {
  await query('update users set company_id = 1 where id = $1', [id]);
  return (await query('select * from users where id = $1', [id]))[0]!;
}

describe('GET /api/actions', () => {
  it('lists the actions the caller may run, with their form', async () => {
    const res = await send('GET', '/api/actions', ops);
    expect(res.status).toBe(200);
    const names = res.body.actions.map((a: { name: string }) => a.name);
    // Not ungranted (add-company), deny-covered (purge-orders), disabled in config
    // (switched-off), or on a hidden table (touch-secrets).
    expect(names).toEqual([
      'fail-after-write',
      'move-user',
      'peek',
      'rename-companies',
      'stamp-login',
    ]);
    const move = res.body.actions.find((a: { name: string }) => a.name === 'move-user');
    expect(move).toEqual({
      name: 'move-user',
      label: 'Move to company',
      on: 'users',
      target: 'one',
      confirm: 'preview',
      destructive: false,
      requireReason: false,
      hasDefaults: true,
      permissions: { users: ['update'], orders: ['update'] },
      inputSchema: {
        type: 'object',
        properties: {
          company: {
            type: 'string',
            minLength: 1,
            maxLength: 10000,
            'x-warden-ref': 'companies',
            label: 'New company',
          },
          cancelPendingOrders: { type: 'boolean', default: false },
          note: { type: 'string', maxLength: 100, sensitive: true },
        },
        required: ['company'],
        additionalProperties: false,
      },
    });
    const rename = res.body.actions.find((a: { name: string }) => a.name === 'rename-companies');
    expect(rename).toMatchObject({ label: 'Add a suffix', requireReason: true, target: 'many' });
  });

  it('lists nothing for a role granted no actions', async () => {
    expect((await send('GET', '/api/actions', viewer)).body).toEqual({ actions: [] });
  });

  it('names runnable actions per entity in capabilities', async () => {
    const caps = (await send('GET', '/api/capabilities', ops)).body;
    expect(caps.entities.users.customActions).toEqual(['move-user', 'peek', 'stamp-login']);
    expect(caps.entities.companies.customActions).toEqual(['fail-after-write', 'rename-companies']);
    expect(
      (await send('GET', '/api/capabilities', viewer)).body.entities.users.customActions,
    ).toEqual([]);
  });

  it('warns about actions disabled at startup and config naming unknown ones', () => {
    const warnings = logLines
      .filter((l) => String(l.msg).startsWith('config: '))
      .map((l) => [l.configPath, l.msg]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        [
          'actions.purge-orders',
          'config: its permissions include delete on "orders", which config denies; the action is disabled',
        ],
        ['actions.touch-secrets', 'config: table "secrets" is not exposed; the action is disabled'],
      ]),
    );
  });
});

describe('who may run an action', () => {
  it.each([
    ['not granted to the role', 'add-company'],
    ['covered by a table deny', 'purge-orders'],
    ['disabled in config', 'switched-off'],
    ['on a hidden table', 'touch-secrets'],
    ['nonexistent', 'no-such-action'],
  ])('answers an action %s with the same 404', async (_, name) => {
    for (const path of ['preview', 'run']) {
      // An invalid body doesn't reveal anything either: the check runs before validation.
      const res = await send('POST', `/api/actions/${name}/${path}`, ops, { records: 'x' });
      expect(res).toMatchObject({ status: 404, body: NOT_FOUND });
    }
    expect((await send('GET', `/api/actions/${name}/defaults`, ops)).body).toEqual(NOT_FOUND);
  });

  it('lets a role run an action without the table grants it writes with', async () => {
    await resetUser(7);
    // ops can't update users through the CRUD routes...
    const crud = await app.inject({
      method: 'PATCH',
      url: '/api/entities/users/7',
      headers: { cookie: ops },
      payload: { version: 'x', values: { full_name: 'nope' } },
    });
    expect(crud.statusCode).toBe(403);
    // ...but may move a user, which is exactly that.
    const res = await run('move-user', { records: ['7'], input: { company: '3' } });
    expect(res.status, res.raw).toBe(200);
    expect((await query('select company_id from users where id = 7'))[0]).toEqual({
      company_id: '3',
    });
  });

  it('refuses cross-site form posts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/actions/move-user/run',
      headers: { cookie: ops, 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('POST /api/actions/:name/run', () => {
  it('commits every write with one parent audit entry linking each changed row', async () => {
    await resetUser(2);
    await query(`update orders set status = 'pending' where user_id = 2`);
    const pending = await query(`select id from orders where user_id = 2 order by id`);
    const before = await auditCount();

    const res = await run('move-user', {
      records: ['2'],
      input: { company: '5', cancelPendingOrders: true, note: 'secret note' },
      reason: '  customer asked  ',
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toEqual({
      auditId: expect.any(String),
      // Only the documented parts of the result are sent.
      result: {
        message: `Moved user2@company3.example to Company 5 (${pending.length})`,
        redirect: { entity: 'users', id: '2' },
      },
    });
    expect((await query('select company_id from users where id = 2'))[0]).toEqual({
      company_id: '5',
    });
    expect(await query(`select distinct status from orders where user_id = 2`)).toEqual([
      { status: 'cancelled' },
    ]);

    const entries = await query(
      `select id, parent_id, action, entity, record_id, actor_subject, actor_roles,
              reason, request_id, details, before, after
       from warden.audit_log where id = $1 or parent_id = $1 order by id`,
      [res.body.auditId],
    );
    expect(await auditCount()).toBe(before + entries.length);
    expect(entries).toHaveLength(2 + pending.length);
    const [parent, ...children] = entries;
    expect(parent).toMatchObject({
      id: res.body.auditId,
      parent_id: null,
      action: 'move-user',
      entity: 'users',
      record_id: '2',
      actor_subject: 'editor',
      reason: 'customer asked',
      before: null,
      after: null,
      // The ref as its id, defaults applied, and the sensitive field redacted.
      details: {
        input: { company: '5', cancelPendingOrders: true, note: '[redacted]' },
        records: ['2'],
        refs: { company: 'companies' },
      },
    });
    expect(children.map((c) => [c.action, c.entity, c.record_id])).toEqual([
      ['update', 'users', '2'],
      ...pending.map((o) => ['update', 'orders', String(o.id)]),
    ]);
    for (const child of children) {
      expect(child).toMatchObject({
        parent_id: parent!.id,
        actor_subject: 'editor',
        actor_roles: parent!.actor_roles,
        reason: 'customer asked',
        request_id: parent!.request_id,
      });
    }
    // The hidden column was never recorded.
    expect(Object.keys(children[0]!.after as object)).not.toContain('password_hash');
    expect(effectList()).toEqual(['moved 2']);
  });

  it('shows the parent and its children in the audit log', async () => {
    await resetUser(3);
    const res = await run('move-user', { records: ['3'], input: { company: '4' } }, admin);
    expect(res.status, res.raw).toBe(200);

    const history = (await send('GET', '/api/entities/users/3/history', admin)).body.items;
    expect(history.slice(0, 2)).toEqual([
      expect.objectContaining({
        action: 'update',
        parent: { id: res.body.auditId, action: 'move-user' },
      }),
      expect.objectContaining({
        id: res.body.auditId,
        action: 'move-user',
        details: { input: { company: '4', cancelPendingOrders: false }, records: ['3'] },
        parent: null,
      }),
    ]);
    const children = (await send('GET', `/api/audit?parent=${res.body.auditId}`, admin)).body.items;
    expect(children).toEqual([expect.objectContaining({ entity: 'users', recordId: '3' })]);
  });

  describe('who sees an action’s own entry', () => {
    const history = async (cookie: string) =>
      (await send('GET', '/api/entities/users/4/history', cookie)).body.items as {
        id: string;
        action: string;
        reason: string | null;
        details: unknown;
        parent: unknown;
      }[];
    let stamp: string;
    let move: string;

    beforeAll(async () => {
      await resetUser(4);
      const stamped = await run('stamp-login', {
        records: ['4'],
        input: { at: '2020-01-02T03:04:05Z', company: '2', codes: ['a1', 'b2'] },
        reason: 'secret reason re login',
      });
      expect(stamped.status, stamped.raw).toBe(200);
      stamp = stamped.body.auditId;
      const moved = await run('move-user', { records: ['4'], input: { company: '3' } });
      expect(moved.status, moved.raw).toBe(200);
      move = moved.body.auditId;
    });

    it('stores sensitive list items redacted', async () => {
      const [entry] = await query('select details from warden.audit_log where id = $1', [stamp]);
      expect(entry!.details).toMatchObject({ input: { codes: '[redacted]' } });
    });

    it('hides it, and its name, from readers not granted the action', async () => {
      const entries = await history(viewer);
      expect(entries.map((e) => e.id)).not.toContain(stamp);
      expect(entries.map((e) => e.id)).not.toContain(move);
      expect(JSON.stringify(entries)).not.toMatch(/secret reason|2020-01-02|stamp-login|move-user/);
      // The row move-user changed is still listed, cut down as usual, without its link.
      expect(entries[0]).toMatchObject({ action: 'update', parent: null });
      expect(entries[0]!.details).toBeNull();
    });

    it('shows it to readers who could run the action', async () => {
      const entries = await history(ops);
      expect(entries.find((e) => e.id === stamp)).toMatchObject({
        reason: 'secret reason re login',
      });
      // Exactly: the stored entity keys of picked records stay on the server.
      expect(entries.find((e) => e.id === stamp)!.details).toEqual({
        input: { at: '2020-01-02T03:04:05Z', company: '2', codes: '[redacted]' },
        records: ['4'],
      });
      expect(entries[0]).toMatchObject({ parent: { id: move, action: 'move-user' } });
    });

    it('shows audit admins every action, without records picked from tables they can’t read', async () => {
      const expected = {
        reason: 'secret reason re login',
        details: {
          input: { at: '2020-01-02T03:04:05Z', codes: '[redacted]' },
          records: ['4'],
          redacted: true,
        },
      };
      expect((await history(auditor)).find((e) => e.id === stamp)).toEqual(
        expect.objectContaining(expected),
      );
      const search = (await send('GET', '/api/audit?action=stamp-login', auditor)).body.items;
      expect(search.find((e: { id: string }) => e.id === stamp)).toEqual(
        expect.objectContaining(expected),
      );
      expect((await history(admin)).find((e) => e.id === stamp)).toMatchObject({
        details: { input: { company: '2' } },
      });
    });
  });

  it('runs against several records', async () => {
    const res = await send('POST', '/api/actions/rename-companies/run', admin, {
      records: ['10', '11'],
      input: { suffix: ' (renamed)' },
      reason: 'rebrand',
    });
    expect(res.status, res.raw).toBe(200);
    expect(await query('select name from companies where id in (10, 11) order by id')).toEqual([
      { name: 'Company 10 (renamed)' },
      { name: 'Company 11 (renamed)' },
    ]);
  });

  it('runs an action without records and follows its redirect', async () => {
    const res = await run('add-company', { input: { name: 'Acme' } }, admin);
    expect(res.status, res.raw).toBe(200);
    const id = res.body.result.redirect.id;
    expect((await query('select name from companies where id = $1', [id]))[0]).toEqual({
      name: 'Acme',
    });
  });

  it('requires a reason when config says so', async () => {
    const res = await send('POST', '/api/actions/rename-companies/run', admin, {
      records: ['12'],
      input: { suffix: 'x' },
      reason: '   ',
    });
    expect(res).toMatchObject({
      status: 400,
      body: { message: 'a reason is required for this change' },
    });
  });

  it.each([
    ['no records', { input: { company: '2' } }],
    ['two records', { records: ['1', '2'], input: { company: '2' } }],
  ])('rejects %s for a one-record action', async (_, body) => {
    expect((await run('move-user', body)).status).toBe(400);
  });

  it('rejects records for an action that takes none, and repeated records', async () => {
    expect((await run('add-company', { records: ['1'], input: { name: 'x' } }, admin)).status).toBe(
      400,
    );
    const repeated = await send('POST', '/api/actions/rename-companies/run', admin, {
      records: ['1', '1'],
      input: { suffix: 'x' },
      reason: 'r',
    });
    expect(repeated.status).toBe(400);
  });

  it('gives a missing and a malformed target record the same 404', async () => {
    const missing = await run('move-user', { records: ['999999'], input: { company: '2' } });
    const malformed = await run('move-user', { records: ['abc'], input: { company: '2' } });
    expect(missing).toMatchObject({ status: 404, body: NOT_FOUND });
    expect(malformed.body).toEqual(missing.body);
  });

  it('rejects unknown and invalid input', async () => {
    const unknown = await run('move-user', { records: ['4'], input: { company: '2', extra: 1 } });
    expect(unknown).toMatchObject({
      status: 400,
      body: {
        message: 'invalid input',
        details: [{ field: 'extra', message: 'unknown field "extra"' }],
      },
    });
    const invalid = await run('move-user', {
      records: ['4'],
      input: { cancelPendingOrders: 'yes' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.details.map((d: { field: string }) => d.field).sort()).toEqual([
      'cancelPendingOrders',
      'company',
    ]);
  });

  it('gives tampered and nonexistent picked records the same error', async () => {
    const before = await auditCount();
    for (const company of ['999999', 'not-a-number', '1e3', "1' or '1'='1"]) {
      const res = await run('move-user', { records: ['4'], input: { company } });
      expect(res).toMatchObject({
        status: 400,
        body: {
          message: 'invalid input',
          details: [{ field: 'company', message: 'references a record that does not exist' }],
        },
      });
    }
    expect(await auditCount()).toBe(before);
  });

  it('sends the author’s own error message, attached to its field', async () => {
    const user = await resetUser(5);
    const res = await run('move-user', { records: ['5'], input: { company: user.company_id } });
    expect(res).toMatchObject({
      status: 400,
      body: {
        message: 'already at that company',
        details: [{ field: 'company', message: 'already at that company' }],
      },
    });
  });
});

describe('rollback', () => {
  const company = () => query('select name from companies where id = 20');

  it.each([
    ['the author’s ActionError', 'action-error', 400, { message: 'the author says no' }],
    ['an unexpected error', 'crash', 500, SERVER_ERROR],
    ['an error with a 4xx statusCode', 'upstream', 500, SERVER_ERROR],
    ['a write outside permissions', 'outside-permissions', 500, SERVER_ERROR],
    ['a filter on a hidden column', 'hidden-column', 400, { message: 'invalid users filter' }],
    ['a hidden table', 'hidden-table', 400, { message: 'unknown entity "secrets"' }],
    ['a read-only field', 'read-only', 400, { message: 'invalid companies values' }],
    ['an invalid value', 'bad-value', 400, { message: 'invalid companies values' }],
    ['a constraint violation', 'duplicate', 409, { message: 'conflicts with existing records' }],
    [
      'a constraint violation run caught',
      'swallowed-duplicate',
      409,
      { message: 'conflicts with existing records' },
    ],
    ['tx calls run did not await', 'unawaited', 500, SERVER_ERROR],
    ['exceeding maxAffectedRows', 'cap', 500, SERVER_ERROR],
  ])('undoes every write, audit entries included, on %s', async (_, how, status, body) => {
    const name = await company();
    const before = await auditCount();
    const res = await run('fail-after-write', { records: ['20'], input: { how } }, admin);
    expect(res.status, res.raw).toBe(status);
    expect(res.body).toMatchObject(body);
    expect(await company()).toEqual(name);
    expect(await auditCount()).toBe(before);
    expect(effectList()).toEqual([]);
    // Nothing internal leaks into the response.
    expect(res.raw).not.toMatch(/internal details|companies_domain_key|sql|upstream|token/i);
  });

  it('sends a generic 500 for errors action code throws with a 4xx statusCode', async () => {
    for (const res of [
      await run('fail-after-write', { records: ['20'], input: { how: 'upstream' } }),
      await preview('fail-after-write', { records: ['20'], input: { how: 'upstream' } }),
      await send('GET', '/api/actions/fail-after-write/defaults?record=1', ops),
      await send('GET', '/api/actions/fail-after-write/defaults', ops),
    ]) {
      expect(res.status, res.raw).toBe(500);
      expect(res.body).toEqual(SERVER_ERROR);
    }
    expect(logLines).toContainEqual(
      expect.objectContaining({
        action: 'fail-after-write',
        err: expect.objectContaining({ message: expect.stringMatching(/^upstream said/) }),
      }),
    );
    // The author's own error still reaches the user.
    const own = await send('GET', '/api/actions/fail-after-write/defaults?record=20', ops);
    expect(own).toMatchObject({ status: 400, body: { message: 'no defaults for this one' } });
  });

  it('names only fields the caller can read in invalid tx calls', async () => {
    const fail = (how: string, cookie = ops) =>
      run('fail-after-write', { records: ['20'], input: { how } }, cookie);
    // ops can't read users.last_login_at.
    const unreadable = await fail('unreadable-field');
    expect(unreadable).toMatchObject({ status: 400, body: { message: 'invalid users values' } });
    expect(unreadable.body.details).toBeUndefined();
    expect(unreadable.raw).not.toMatch(/last_login_at/);
    expect((await fail('unreadable-field', admin)).body.details).toEqual([
      { message: expect.stringMatching(/^last_login_at: /) },
    ]);
    expect((await fail('readable-field')).body).toMatchObject({
      message: 'invalid users values',
      details: [{ message: expect.stringMatching(/^full_name: /) }],
    });
    // A filter's problems don't say which field they're about, so only those who can read every
    // field get them.
    const filter = await fail('missing-column');
    expect(filter).toMatchObject({ status: 400, body: { message: 'invalid users filter' } });
    expect(filter.body.details).toBeUndefined();
    // ops can't read orders at all, so it isn't named.
    const entity = await fail('unreadable-entity');
    expect(entity).toMatchObject({
      status: 400,
      body: { message: 'the action made an invalid change' },
    });
    expect(entity.body.details).toBeUndefined();
    expect(entity.raw).not.toMatch(/orders|status:/);
    expect((await fail('unreadable-entity', admin)).body).toMatchObject({
      message: 'invalid orders values',
      details: [{ message: expect.stringMatching(/^status: /) }],
    });
  });

  it('previews a caught constraint violation as the error, not as the result', async () => {
    const res = await preview(
      'fail-after-write',
      { records: ['20'], input: { how: 'swallowed-duplicate' } },
      admin,
    );
    expect(res.status, res.raw).toBe(409);
    expect(res.body).toMatchObject({ message: 'conflicts with existing records' });
  });

  it('logs tx calls run did not await, and keeps serving', async () => {
    await run('fail-after-write', { records: ['20'], input: { how: 'unawaited' } }, admin);
    expect(logLines).toContainEqual(
      expect.objectContaining({
        err: expect.objectContaining({
          message: expect.stringMatching(/2 tx calls still running/),
        }),
      }),
    );
    expect((await send('GET', '/api/actions', ops)).status).toBe(200);
  });

  it('treats hidden columns and tables exactly like nonexistent ones', async () => {
    const hidden = await run(
      'fail-after-write',
      { records: ['20'], input: { how: 'hidden-column' } },
      admin,
    );
    const missing = await run(
      'fail-after-write',
      { records: ['20'], input: { how: 'missing-column' } },
      admin,
    );
    expect(hidden.body).toEqual({
      ...missing.body,
      details: [{ message: 'unknown field "password_hash"' }],
    });
    expect(missing.body.details).toEqual([{ message: 'unknown field "nonexistent"' }]);
    const table = await run(
      'fail-after-write',
      { records: ['20'], input: { how: 'hidden-table' } },
      admin,
    );
    const noTable = await run(
      'fail-after-write',
      { records: ['20'], input: { how: 'missing-table' } },
      admin,
    );
    expect(table.body.message).toBe('unknown entity "secrets"');
    expect(noTable.body).toEqual({ ...table.body, message: 'unknown entity "nonexistent"' });
    const peek = await run('peek', { records: ['8'] });
    expect(peek.status, peek.raw).toBe(200);
    const seen = JSON.parse(peek.body.result.message);
    expect(seen.keys).not.toContain('password_hash');
    // The action reads with config's view, not the caller's field rules.
    expect(seen.keys).toContain('last_login_at');
    expect(seen).toMatchObject({ missing: null, tampered: null });
  });
});

describe('picked records', () => {
  it('looks them up together, in order, repeats included', async () => {
    const res = await run('pick-users', { input: { users: ['3', '2', '3'] } }, admin);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.result.message).toBe('3,2,3');
    const missing = await run('pick-users', { input: { users: ['3', '999999', 'x'] } }, admin);
    expect(missing.body.details).toEqual([
      { field: 'users', message: 'item 1: references a record that does not exist' },
      { field: 'users', message: 'item 2: references a record that does not exist' },
    ]);
  });

  it('refuses more than an array field takes, before looking any up', async () => {
    const users = Array.from({ length: 501 }, (_, i) => String(i + 1));
    const res = await run('pick-users', { input: { users } }, admin);
    expect(res).toMatchObject({
      status: 400,
      body: { details: [{ field: 'users', message: 'must hold at most 500 items' }] },
    });
  });
});

describe('limits', () => {
  const idleInTransaction = async () =>
    Number(
      (
        await query(
          `select count(*) as n from pg_stat_activity
           where datname = current_database() and state like 'idle in transaction%'`,
        )
      )[0]!.n,
    );

  it('rolls back a run past its deadline, frees its connection, and keeps others responsive', async () => {
    let settled = false;
    const hung = Promise.all([
      preview('hang', {}, admin),
      run('hang', {}, admin),
      preview('hang', {}, admin),
    ]).finally(() => (settled = true));
    // Other requests don't wait for the hung ones.
    expect((await send('GET', '/api/actions', ops)).status).toBe(200);
    const peek = await run('peek', { records: ['8'] });
    expect(peek.status, peek.raw).toBe(200);
    expect(settled).toBe(false);

    const responses = await hung;
    // Two per user: whichever came third was refused.
    const refused = responses.filter((r) => r.status === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body.message).toMatch(/too many actions/);
    for (const res of responses.filter((r) => r.status !== 429)) {
      expect(res).toMatchObject({
        status: 503,
        body: { message: 'the action took too long and was rolled back' },
      });
    }
    await expect.poll(idleInTransaction).toBe(0);
    // The slots are free again.
    const again = await Promise.all([preview('hang', {}, admin), preview('hang', {}, admin)]);
    expect(again.map((r) => r.status)).toEqual([503, 503]);
  });
});

describe('POST /api/actions/:name/preview', () => {
  it('shows the change set and commits nothing', async () => {
    await resetUser(6);
    await query(`update orders set status = 'pending' where user_id = 6`);
    const before = await auditCount();
    const res = await preview('move-user', {
      records: ['6'],
      input: { company: '9', cancelPendingOrders: true },
    });
    expect(res.status, res.raw).toBe(200);
    const orders = await query('select id from orders where user_id = 6 order by id');
    expect(res.body).toMatchObject({
      total: 1 + orders.length,
      truncated: false,
      result: { message: expect.stringContaining('Company 9') },
      previewToken: expect.any(String),
    });
    expect(res.body.changes[0]).toMatchObject({
      operation: 'update',
      entity: 'users',
      recordId: '6',
      diff: { company_id: { from: '1', to: '9' } },
    });
    // ops can't read last_login_at, so the preview doesn't show it.
    expect(Object.keys(res.body.changes[0].after)).not.toContain('last_login_at');
    expect((await query('select company_id from users where id = 6'))[0]).toEqual({
      company_id: '1',
    });
    expect(await query(`select distinct status from orders where user_id = 6`)).toEqual([
      { status: 'pending' },
    ]);
    expect(await auditCount()).toBe(before);
    expect(effectList()).toEqual([]);

    // The token commits exactly what was previewed.
    const done = await run('move-user', {
      records: ['6'],
      input: { company: '9', cancelPendingOrders: true },
      previewToken: res.body.previewToken,
    });
    expect(done.status, done.raw).toBe(200);
    expect((await query('select company_id from users where id = 6'))[0]).toEqual({
      company_id: '9',
    });
  });

  it('refuses a stale preview and commits nothing', async () => {
    await resetUser(9);
    const body = { records: ['9'], input: { company: '4' } };
    const { previewToken } = (await preview('move-user', body)).body;
    // A change to a field the action doesn't touch doesn't change what it would do...
    await query(`update users set full_name = 'Changed' where id = 9`);
    const unaffected = await preview('move-user', body);
    expect(unaffected.body.previewToken).toBe(previewToken);
    // ...but someone moving the user in between does.
    await query(`update users set company_id = 2 where id = 9`);
    const before = await auditCount();
    const res = await run('move-user', { ...body, previewToken });
    expect(res).toMatchObject({ status: 409, body: { error: 'preview_stale' } });
    expect((await query('select company_id from users where id = 9'))[0]).toEqual({
      company_id: '2',
    });
    expect(await auditCount()).toBe(before);
    expect(effectList()).toEqual([]);
  });

  it('refuses a token for different input', async () => {
    await resetUser(11);
    const { previewToken } = (
      await preview('move-user', { records: ['11'], input: { company: '4' } })
    ).body;
    const res = await run('move-user', { records: ['11'], input: { company: '5' }, previewToken });
    expect(res.status).toBe(409);
  });

  it('matches creates across previews although sequences move on', async () => {
    const body = { input: { name: 'Previewed' } };
    const first = (await preview('add-company', body, admin)).body;
    const second = (await preview('add-company', body, admin)).body;
    expect(second.changes[0].recordId).not.toBe(first.changes[0].recordId);
    expect(second.previewToken).toBe(first.previewToken);
    const res = await run('add-company', { ...body, previewToken: first.previewToken }, admin);
    expect(res.status, res.raw).toBe(200);
  });
});

describe('GET /api/actions/:name/defaults', () => {
  it('prefills the form from the record and the actor', async () => {
    const res = await send('GET', '/api/actions/move-user/defaults?record=4', ops);
    expect(res).toMatchObject({
      status: 200,
      body: { values: { note: 'editor:user4@company5.example' } },
    });
    expect((await send('GET', '/api/actions/move-user/defaults', ops)).body).toEqual({
      values: { note: 'editor:' },
    });
    expect((await send('GET', '/api/actions/move-user/defaults?record=abc', ops)).body).toEqual(
      NOT_FOUND,
    );
    expect((await send('GET', '/api/actions/rename-companies/defaults', ops)).body).toEqual({
      values: {},
    });
  });
});

describe('the example actions', () => {
  it('load with the example config without warnings', async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const example = await createWarden({
      env: {
        DATABASE_URL: db.connectionString,
        WARDEN_CONFIG: EXAMPLE_CONFIG,
        WARDEN_ACTIONS: EXAMPLE_ACTIONS,
        ...authEnv(idp),
      },
      logger: { level: 'warn', stream },
    });
    try {
      expect(lines.filter((l) => String(l.msg).startsWith('config: '))).toEqual([]);
      const cookie = await login(example, 'editor');
      const res = await example.inject({ method: 'GET', url: '/api/actions', headers: { cookie } });
      expect(res.json().actions.map((a: { name: string }) => a.name)).toEqual([
        'deactivate-users',
        'move-user',
      ]);
    } finally {
      await example.close();
    }
  });
});

describe('loading WARDEN_ACTIONS', () => {
  const start = (actions: string, config = CONFIG) =>
    createWarden({
      env: {
        DATABASE_URL: db.connectionString,
        WARDEN_CONFIG: writeConfig(config),
        WARDEN_ACTIONS: actions,
        ...authEnv(idp),
      },
    });
  const module = (source: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'warden-actions-')), 'actions.mjs');
    writeFileSync(file, source);
    return file;
  };
  const problems = async (actions: string) => {
    const err = await start(actions).then(
      async (started) => {
        await started.close();
        return undefined;
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ActionsError);
    return (err as ActionsError).problems;
  };

  it('fails startup when the module is missing, throws, or exports no function', async () => {
    expect(await problems('/nonexistent/actions.js')).toEqual(['the file does not exist']);
    expect(await problems(module('throw new Error("boom")'))).toEqual([
      'importing it failed: boom',
    ]);
    expect(await problems(module('export default 1'))).toEqual([
      'its default export must be a function that returns actions',
    ]);
    expect(await problems(module('export default () => ({})'))).toEqual([
      'the module must return an array of actions',
    ]);
    expect(await problems(module('export const apiVersion = 2; export default () => []'))).toEqual([
      'it was written for actions API 2, but this Warden supports 1',
    ]);
  });

  it('fails startup listing every invalid definition', async () => {
    const source = `export default ({ defineAction, z }) => [
      defineAction({ name: 'ok', label: 'Ok', on: 'users', permissions: {}, run: async () => {} }),
      defineAction({ name: 'ok', label: 'Again', on: 'users', permissions: {}, run: async () => {} }),
      defineAction({ name: 'Bad Name', label: 'x', on: 'users', permissions: {}, run: async () => {} }),
      defineAction({ name: 'perm', label: 'x', on: 'users', permissions: { users: ['read'] }, run: async () => {} }),
      defineAction({ name: 'nested', label: 'x', on: 'users', permissions: {},
        input: z.object({ address: z.object({ city: z.string() }) }), run: async () => {} }),
      defineAction({ name: 'union', label: 'x', on: 'users', permissions: {},
        input: z.object({ v: z.union([z.string(), z.number()]) }), run: async () => {} }),
      defineAction({ name: 'transform', label: 'x', on: 'users', permissions: {},
        input: z.object({ v: z.string().transform((s) => s.length) }), run: async () => {} }),
      defineAction({ name: 'typo', label: 'x', on: 'users', permision: {}, run: async () => {} }),
    ]`;
    const list = await problems(module(source));
    expect(list).toEqual([
      'action "ok": name is used by another action',
      'action "Bad Name": name must match ^[a-z][a-z0-9-]*$',
      'action "perm": permissions.users may only list create, update and delete',
      'action "nested": input field "address": only strings, numbers, booleans, enums and dates are supported',
      'action "union": input field "v": unions are not supported',
      expect.stringMatching(/^action "transform": input can't be shown as a form/),
      'action "typo": unknown key "permision"',
      'action "typo": permissions must map tables to create, update and delete',
    ]);
  });

  it('fails startup for a record action on a table without a primary key', async () => {
    await db.exec('create table if not exists logbook (line text)');
    const source = `export default ({ defineAction }) => [
      defineAction({ name: 'log', label: 'x', on: 'logbook', permissions: {}, run: async () => {} }),
    ]`;
    const err = await start(module(source)).catch((e: unknown) => e);
    expect((err as ActionsError).problems).toEqual([
      'action "log": target "one" needs records, but "logbook" has no primary key',
    ]);
  });
});
