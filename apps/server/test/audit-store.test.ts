import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';
import { exampleConfigWith } from './helpers/config.js';

type App = Awaited<ReturnType<typeof createWarden>>;

const EXAMPLE_ACTIONS = fileURLToPath(
  new URL('../../../examples/basic/actions/index.js', import.meta.url),
);

// The application's own audit table, in its own names, holding its own entries too.
const AUDIT_TABLES = `
  create table change_log (
    id          bigint generated always as identity primary key,
    created_at  timestamptz not null default now(),
    request_id  text,
    actor_sub   text not null,
    actor_email text,
    actor_id    text,
    actor_roles text[],
    action      text not null,
    table_name  text not null,
    record_id   text,
    primary_key jsonb,
    old_values  jsonb,
    new_values  jsonb,
    diff        jsonb,
    details     jsonb,
    reason      text,
    written     text[],
    parent_id   bigint references change_log (id),
    source      text not null default 'app'
  );
  create schema app_audit;
  -- Outside the schemas Warden exposes, and not what its mapping expects.
  create table app_audit.change_log (
    id         serial primary key,
    created_at date not null default current_date,
    actor_sub  text not null,
    action     text not null,
    table_name text not null,
    record_id  text,
    diff       jsonb,
    details    jsonb
  );
`;

const COLUMNS = {
  id: 'id',
  occurredAt: 'created_at',
  requestId: 'request_id',
  actorSubject: 'actor_sub',
  actorEmail: 'actor_email',
  actorUserId: 'actor_id',
  actorRoles: 'actor_roles',
  action: 'action',
  entity: 'table_name',
  recordId: 'record_id',
  primaryKey: 'primary_key',
  before: 'old_values',
  after: 'new_values',
  diff: 'diff',
  details: 'details',
  reason: 'reason',
  written: 'written',
  parentId: 'parent_id',
};

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: App;
let admin: string;
let viewer: string;
const logLines: Record<string, unknown>[] = [];

const capture = (lines: Record<string, unknown>[]) =>
  new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });

const start = (audit: unknown, lines: Record<string, unknown>[]) =>
  createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: exampleConfigWith((config) => {
        Object.assign(config, { audit });
        // These tests are about where entries go, not about reasons.
        config.defaults.requireReason = [];
        config.actions['move-user'] = { ...config.actions['move-user'], requireReason: false };
        config.tables.companies = { ...config.tables.companies!, allowDelete: true };
        config.roles.admin!.grants.companies = ['delete'];
      }),
      WARDEN_ACTIONS: EXAMPLE_ACTIONS,
      ...authEnv(idp),
    },
    logger: { level: 'info', stream: capture(lines) },
  });

beforeAll(async () => {
  db = await startPostgres({
    sql: [
      await readExampleSql('basic/schema.sql'),
      await readExampleSql('basic/seed.sql'),
      AUDIT_TABLES,
    ],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  app = await start(
    {
      store: 'table',
      table: 'change_log',
      columns: COLUMNS,
      source: { column: 'source', value: 'warden' },
    },
    logLines,
  );
  admin = await login(app, 'admin');
  viewer = await login(app, 'viewer');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const send = async (app: App, method: string, url: string, cookie: string, payload?: object) => {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  const json = res.headers['content-type']?.toString().startsWith('application/json');
  return { status: res.statusCode, body: json ? res.json() : undefined, raw: res.body };
};
const query = async (text: string, params: unknown[] = []) =>
  (await sqlPool.query<Record<string, unknown>>(text, params)).rows;
const changeLog = (where = 'true', params: unknown[] = []) =>
  query(
    `select id::text, action, table_name, record_id, actor_sub, actor_roles, reason, source,
            parent_id::text, details
     from change_log where ${where} order by change_log.id`,
    params,
  );
const wardenCount = async () =>
  Number((await query('select count(*) from warden.audit_log'))[0]!.count);

describe('audit.store: table', () => {
  it('logs that the role can tamper with the table, not about warden.audit_log', () => {
    const warnings = logLines.filter((l) => l.level === 40).map((l) => String(l.msg));
    expect(warnings).toContainEqual(
      expect.stringMatching(
        /can update, delete from, or truncate the audit table public\.change_log/,
      ),
    );
    expect(warnings.some((m) => m.includes('warden.audit_log'))).toBe(false);
  });

  it('writes every audited event to the table, in the write transaction', async () => {
    const before = await wardenCount();
    const created = await send(app, 'POST', '/api/entities/companies', admin, {
      values: { name: 'Audited Co' },
      reason: 'onboarding',
    });
    expect(created.status, created.raw).toBe(201);
    const id = created.body.id as string;
    const updated = await send(app, 'PATCH', `/api/entities/companies/${id}`, admin, {
      version: created.body.version,
      values: { plan: 'team' },
    });
    expect(updated.status, updated.raw).toBe(200);
    const ran = await send(app, 'POST', '/api/actions/move-user/run', admin, {
      records: ['2'],
      input: { company: id },
    });
    expect(ran.status, ran.raw).toBe(200);
    const exported = await send(app, 'GET', '/api/export/companies', admin);
    expect(exported.status).toBe(200);
    const assignment = { email: 'someone@example.com', role: 'ops' };
    expect(
      (await send(app, 'POST', '/api/admin/roles/assignments', admin, assignment)).status,
    ).toBe(201);
    expect(
      (await send(app, 'DELETE', '/api/admin/roles/assignments', admin, assignment)).status,
    ).toBe(204);
    const revoked = await send(app, 'DELETE', '/api/admin/roles/sessions', admin, {
      subject: 'viewer',
    });
    expect(revoked.body).toEqual({ revoked: 1 });
    viewer = await login(app, 'viewer');
    const drift = await send(app, 'GET', '/api/admin/schema-drift', admin);
    const acknowledged = await send(app, 'POST', '/api/admin/schema-drift/acknowledge', admin, {
      baselineId: drift.body.baseline.id,
    });
    expect(acknowledged.status, acknowledged.raw).toBe(200);
    const deleted = await send(app, 'DELETE', `/api/entities/companies/${id}`, admin, {
      version: (await send(app, 'GET', `/api/entities/companies/${id}`, admin)).body.version,
    });
    expect(deleted.status, deleted.raw).toBe(204);

    expect(await wardenCount()).toBe(before);
    const rows = await changeLog();
    expect(rows.map((r) => [r.action, r.table_name, r.source])).toEqual([
      ['create', 'companies', 'warden'],
      ['update', 'companies', 'warden'],
      ['move-user', 'users', 'warden'],
      ['update', 'users', 'warden'],
      ['export', 'companies', 'warden'],
      ['assign', 'warden.role_assignments', 'warden'],
      ['unassign', 'warden.role_assignments', 'warden'],
      ['revoke_sessions', 'warden.sessions', 'warden'],
      ['acknowledge', 'warden.schema_snapshots', 'warden'],
      ['delete', 'companies', 'warden'],
    ]);
    expect(rows[0]).toMatchObject({ actor_sub: 'admin', reason: 'onboarding', record_id: id });
    // The action's changes point at its entry.
    expect(rows[3]!.parent_id).toBe(rows[2]!.id);
  });

  it('rolls the change back when the entry cannot be written', async () => {
    await query(`
      create function fail_audit() returns trigger language plpgsql as $$
        begin raise exception 'audit storage unavailable'; end; $$;
      create trigger fail_audit before insert on change_log
        for each row when (new.reason = 'fail the audit') execute function fail_audit();
    `);
    try {
      const companies = async () =>
        Number((await query(`select count(*) from companies`))[0]!.count);
      const before = await companies();
      const res = await send(app, 'POST', '/api/entities/companies', admin, {
        values: { name: 'Never' },
        reason: 'fail the audit',
      });
      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Internal Server Error');
      expect(res.raw).not.toMatch(/audit storage/);
      expect(await companies()).toBe(before);
    } finally {
      await query('drop trigger fail_audit on change_log; drop function fail_audit()');
    }
  });

  it('serves History and the audit log from the table, with app entries and the source', async () => {
    const created = await send(app, 'POST', '/api/entities/companies', admin, {
      values: { name: 'History Co' },
    });
    const id = created.body.id as string;
    await query(
      `insert into change_log (actor_sub, action, table_name, record_id, diff, source)
       values ('billing-job', 'invoice', 'companies', $1, '{"plan": {"from": "free", "to": "team"}}', 'billing')`,
      [id],
    );
    const history = await send(app, 'GET', `/api/entities/companies/${id}/history`, viewer);
    expect(history.status, history.raw).toBe(200);
    expect(
      history.body.items.map((e: { action: string; source: string }) => [e.action, e.source]),
    ).toEqual([
      ['invoice', 'billing'],
      ['create', 'warden'],
    ]);
    // Roles stay for audit admins.
    expect(history.body.items[1].actor).toEqual({
      subject: 'admin',
      email: 'admin@example.com',
    });

    const search = await send(app, 'GET', '/api/audit?source=billing', admin);
    expect(search.status, search.raw).toBe(200);
    expect(search.body.items.map((e: { action: string }) => e.action)).toEqual(['invoice']);
    const all = await send(app, 'GET', '/api/audit?limit=200', admin);
    expect(all.body.items.some((e: { action: string }) => e.action === 'assign')).toBe(true);
    const parent = all.body.items.find((e: { action: string }) => e.action === 'move-user');
    const children = await send(app, 'GET', `/api/audit?parent=${parent.id}`, admin);
    expect(children.body.items).toHaveLength(1);
    expect(children.body.items[0].parent).toEqual({ id: parent.id, action: 'move-user' });
  });

  it('never exposes the audit table, however it is reached', async () => {
    const schema = await send(app, 'GET', '/api/schema', admin);
    expect(schema.body.entities.map((e: { key: string }) => e.key)).not.toContain('change_log');
    const [row] = await changeLog();
    const missing = await send(app, 'GET', '/api/entities/no_such_table', admin);
    for (const [method, url, payload] of [
      ['GET', '/api/entities/change_log'],
      ['GET', `/api/entities/change_log/${row!.id}`],
      ['GET', `/api/entities/change_log/${row!.id}/history`],
      ['POST', '/api/entities/change_log', { values: { action: 'forged' } }],
      ['PATCH', `/api/entities/change_log/${row!.id}`, { version: 'x', values: { reason: 'x' } }],
      ['DELETE', `/api/entities/change_log/${row!.id}`, { version: 'x' }],
      ['GET', '/api/export/change_log'],
      ['GET', '/api/export/public.change_log'],
    ] as const) {
      const res = await send(app, method, url, admin, payload);
      expect([res.status, res.body], `${method} ${url}`).toEqual([missing.status, missing.body]);
    }
    const audit = await send(app, 'GET', '/api/audit?entity=change_log', admin);
    expect(audit.status).toBe(400);
    expect(await changeLog(`action = 'forged'`)).toEqual([]);
  });
});

describe('a misconfigured audit table', () => {
  let broken: App;
  let brokenAdmin: string;
  const lines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    broken = await start({ store: 'table', table: 'app_audit.change_log' }, lines);
    brokenAdmin = await login(broken, 'admin');
  });

  afterAll(async () => {
    await broken?.close();
  });

  it('starts, warning about each problem', () => {
    const warnings = lines
      .filter((l) => l.configPath === 'audit')
      .map((l) => String(l.msg).replace('config: audit table "app_audit.change_log": ', ''));
    expect(warnings).toEqual(
      expect.arrayContaining([
        'column "occurred_at" (occurredAt) does not exist in "app_audit.change_log"; changes are refused until fixed',
      ]),
    );
    expect(warnings.length).toBeGreaterThan(5);
  });

  it('refuses every audited change with a clear 503, and changes nothing', async () => {
    const before = await query('select count(*) from companies');
    const refused = {
      statusCode: 503,
      error: 'Service Unavailable',
      message:
        'the audit log is misconfigured: changes are disabled and the log is unreadable until it is fixed',
    };
    const attempts = [
      ['POST', '/api/entities/companies', { values: { name: 'Unaudited' } }],
      ['POST', '/api/actions/move-user/run', { records: ['3'], input: { company: '4' } }],
      ['GET', '/api/export/companies'],
      ['POST', '/api/admin/roles/assignments', { email: 'x@example.com', role: 'ops' }],
      ['GET', '/api/audit'],
      ['GET', '/api/entities/companies/1/history'],
    ] as const;
    for (const [method, url, payload] of attempts) {
      const res = await send(broken, method, url, brokenAdmin, payload);
      expect([res.status, res.body], `${method} ${url}`).toEqual([503, refused]);
    }
    expect(await query('select count(*) from companies')).toEqual(before);
    expect(
      await query(`select 1 from warden.role_assignments where email = 'x@example.com'`),
    ).toEqual([]);
    expect(await query('select count(*) from app_audit.change_log')).toEqual([{ count: '0' }]);
  });

  it('keeps reads working', async () => {
    const list = await send(broken, 'GET', '/api/entities/companies?limit=5', brokenAdmin);
    expect(list.status, list.raw).toBe(200);
    expect(list.body.items).toHaveLength(5);
    expect((await send(broken, 'GET', '/api/entities/companies/1', brokenAdmin)).status).toBe(200);
  });
});
