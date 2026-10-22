import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { AuditEntry } from '@wardenhq/core';
import { MOCK_USERS, type MockOidc } from '@wardenhq/mock-oidc';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import {
  authEnv,
  beginLogin,
  callback,
  login,
  signInAtIdp,
  startTestIdp,
  writeConfig,
} from './helpers/auth.js';

type App = Awaited<ReturnType<typeof createWarden>>;

const ADA = '00000000-0000-0000-0000-00000000000a';

const SCHEMA = `
  create table staff (
    id     uuid primary key,
    email  text,
    secret text default 'never shown'
  );
  insert into staff (id, email) values
    ('${ADA}', 'Admin@Example.com'),
    ('00000000-0000-0000-0000-00000000000b', 'editor@example.com'),
    ('00000000-0000-0000-0000-00000000000c', 'EDITOR@example.com'),
    ('00000000-0000-0000-0000-00000000000d', 'cfo@example.com');

  create table notes (id serial primary key, body text);
  create table notes_log (
    id serial primary key, op text, actor_id text, actor_sub text, actor_email text
  );
  create function log_note() returns trigger language plpgsql as $$
    begin
      insert into notes_log (op, actor_id, actor_sub, actor_email) values (
        tg_op,
        nullif(current_setting('warden.actor_id', true), ''),
        nullif(current_setting('warden.actor_sub', true), ''),
        nullif(current_setting('warden.actor_email', true), ''));
      return coalesce(new, old);
    end;
  $$;
  create trigger notes_log after insert or update or delete on notes
    for each row execute function log_note();
`;

const config = (actor: string) => `
tables:
  staff: { hidden: true }
  notes_log: { hidden: true }
  notes: { allowDelete: true }
roles:
  admin:
    grants: { '*': [read, create, update, export], notes: [delete] }
    admin: [audit, roles]
    actions: ['*']
access:
  groups:
    warden-viewers: [admin]
    warden-editors: [admin]
    warden-admins: [admin]
${actor}
`;
const ACTOR = 'actor: { table: staff, matchColumn: email, idColumn: id }';

const ACTIONS_MODULE = `
export default ({ defineAction, z }) => [
  defineAction({
    name: 'add-note',
    label: 'Add note',
    on: 'notes',
    target: 'none',
    confirm: 'confirm',
    permissions: { notes: ['create'] },
    input: z.object({}),
    async run({ tx, actor }) {
      await tx.create('notes', { body: 'from action' });
      return { message: 'user ' + (actor.userId ?? 'none') };
    },
  }),
];
`;

// An admin by group with an unverified email that has a row, so only verification tells.
const IMPOSTOR = 'impostor';
const USERS = [
  ...MOCK_USERS,
  {
    sub: IMPOSTOR,
    email: 'cfo@example.com',
    emailVerified: false,
    name: 'Imp',
    groups: ['warden-admins'],
  },
];

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: App;
let actionsPath: string;
const logLines: Record<string, unknown>[] = [];

const start = (actorConfig: string, lines: Record<string, unknown>[] = []) =>
  createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: writeConfig(config(actorConfig)),
      WARDEN_ACTIONS: actionsPath,
      ...authEnv(idp),
    },
    logger: {
      level: 'info',
      stream: new Writable({
        write(chunk, _encoding, done) {
          lines.push(JSON.parse(String(chunk)));
          done();
        },
      }),
    },
  });

beforeAll(async () => {
  db = await startPostgres({ sql: [SCHEMA] });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp({ users: USERS });
  const dir = mkdtempSync(join(tmpdir(), 'warden-actor-'));
  actionsPath = join(dir, 'actions.mjs');
  writeFileSync(actionsPath, ACTIONS_MODULE);
  app = await start(ACTOR, logLines);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const tryLogin = async (target: App, sub: string) => {
  const { authorizeUrl, cookies } = await beginLogin(target);
  const res = await callback(target, await signInAtIdp(authorizeUrl, sub), cookies);
  return res.headers.location;
};

const sessionUserIds = async (subject: string) =>
  (
    await sqlPool.query<{ actor_user_id: string | null }>(
      'select actor_user_id from warden.sessions where subject = $1',
      [subject],
    )
  ).rows.map((r) => r.actor_user_id);

const lastAudit = async (action: string) =>
  (
    await sqlPool.query<{ actor_subject: string; actor_user_id: string | null }>(
      `select actor_subject, actor_user_id from warden.audit_log
       where action = $1 order by id desc limit 1`,
      [action],
    )
  ).rows[0];

const noteLog = async () =>
  (
    await sqlPool.query<{
      op: string;
      actor_id: string | null;
      actor_sub: string | null;
      actor_email: string | null;
    }>('select op, actor_id, actor_sub, actor_email from notes_log order by id')
  ).rows;

const send = (target: App, cookie: string, method: string, url: string, payload?: object) =>
  target.inject({
    method: method as 'GET',
    url,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });

describe('actor mapping', () => {
  let admin: string;

  beforeAll(async () => {
    admin = await login(app, 'admin');
  });

  it('resolves the id at login from the verified email, ignoring case', async () => {
    expect(await sessionUserIds('admin')).toEqual([ADA]);
  });

  it('keeps the users table hidden', async () => {
    const res = await send(app, admin, 'GET', '/api/entities/staff');
    expect(res.statusCode).toBe(404);
  });

  it('records the id on CRUD writes, and triggers see it in the transaction', async () => {
    await sqlPool.query('truncate notes_log');
    const created = await send(app, admin, 'POST', '/api/entities/notes', {
      values: { body: 'a' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, version } = created.json<{ id: string; version: string }>();
    const updated = await send(app, admin, 'PATCH', `/api/entities/notes/${id}`, {
      version,
      values: { body: 'b' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const deleted = await send(app, admin, 'DELETE', `/api/entities/notes/${id}`);
    expect(deleted.statusCode, deleted.body).toBe(204);

    const actor = { actor_id: ADA, actor_sub: 'admin', actor_email: 'admin@example.com' };
    expect(await noteLog()).toEqual([
      { op: 'INSERT', ...actor },
      { op: 'UPDATE', ...actor },
      { op: 'DELETE', ...actor },
    ]);
    for (const action of ['create', 'update', 'delete']) {
      expect(await lastAudit(action)).toEqual({ actor_subject: 'admin', actor_user_id: ADA });
    }

    // A write that doesn't go through Warden sees none of it.
    await sqlPool.query('truncate notes_log');
    await sqlPool.query(`insert into notes (body) values ('direct')`);
    expect(await noteLog()).toEqual([
      { op: 'INSERT', actor_id: null, actor_sub: null, actor_email: null },
    ]);
  });

  it('passes the id to custom actions and their transaction', async () => {
    await sqlPool.query('truncate notes_log');
    const res = await send(app, admin, 'POST', '/api/actions/add-note/run', {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ result: { message: `user ${ADA}` } });
    expect(await noteLog()).toEqual([
      { op: 'INSERT', actor_id: ADA, actor_sub: 'admin', actor_email: 'admin@example.com' },
    ]);
    expect(await lastAudit('add-note')).toEqual({ actor_subject: 'admin', actor_user_id: ADA });
    const child = await sqlPool.query<{ actor_user_id: string }>(
      `select actor_user_id from warden.audit_log where action = 'create' and parent_id is not null`,
    );
    expect(child.rows).toEqual([{ actor_user_id: ADA }]);
  });

  it('records the id on exports and role and session events', async () => {
    const exported = await send(app, admin, 'GET', '/api/export/notes');
    expect(exported.statusCode).toBe(200);
    expect(await lastAudit('export')).toEqual({ actor_subject: 'admin', actor_user_id: ADA });

    const assigned = await send(app, admin, 'POST', '/api/admin/roles/assignments', {
      email: 'someone@example.com',
      role: 'admin',
    });
    expect(assigned.statusCode, assigned.body).toBe(201);
    expect(await lastAudit('assign')).toEqual({ actor_subject: 'admin', actor_user_id: ADA });

    await login(app, 'viewer');
    const revoked = await app.inject({
      method: 'DELETE',
      url: '/api/admin/roles/sessions',
      headers: { cookie: admin },
      payload: { subject: 'viewer' },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(await lastAudit('revoke_sessions')).toEqual({
      actor_subject: 'admin',
      actor_user_id: ADA,
    });
  });

  it('shows the id in History and the audit log, and finds entries by it', async () => {
    const created = await send(app, admin, 'POST', '/api/entities/notes', {
      values: { body: 'history' },
    });
    const { id } = created.json<{ id: string }>();
    const history = await send(app, admin, 'GET', `/api/entities/notes/${id}/history`);
    expect(history.json<{ items: AuditEntry[] }>().items[0]?.actor).toMatchObject({
      subject: 'admin',
      userId: ADA,
    });
    const search = await send(app, admin, 'GET', `/api/audit?actor=${ADA}&action=create`);
    expect(search.statusCode, search.body).toBe(200);
    const items = search.json<{ items: AuditEntry[] }>().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((e) => e.actor.userId === ADA)).toBe(true);
  });

  it('gives no id, with a warning, when several rows match', async () => {
    const editor = await login(app, 'editor');
    expect(await sessionUserIds('editor')).toEqual([null]);
    expect(logLines).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'actor: several users match the email; no user id',
      }),
    );
    // Writes still work, unattributed.
    await sqlPool.query('truncate notes_log');
    const res = await send(app, editor, 'POST', '/api/entities/notes', { values: { body: 'e' } });
    expect(res.statusCode).toBe(201);
    expect(await noteLog()).toEqual([
      { op: 'INSERT', actor_id: null, actor_sub: 'editor', actor_email: 'editor@example.com' },
    ]);
    expect(await lastAudit('create')).toEqual({ actor_subject: 'editor', actor_user_id: null });
  });

  it('never matches an unverified email', async () => {
    await login(app, IMPOSTOR);
    expect(await sessionUserIds(IMPOSTOR)).toEqual([null]);
  });

  it('ignores an id stored on a session once the mapping is gone', async () => {
    const unmapped = await start('');
    try {
      const res = await send(unmapped, admin, 'POST', '/api/entities/notes', {
        values: { body: 'x' },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(await lastAudit('create')).toEqual({ actor_subject: 'admin', actor_user_id: null });
    } finally {
      await unmapped.close();
    }
  });
});

describe('actor.required', () => {
  const REQUIRED = 'actor: { table: staff, matchColumn: email, idColumn: id, required: true }';

  it('denies sign-in to users without an id, and sessions that have none', async () => {
    const viewer = await login(app, 'viewer');
    const strict = await start(REQUIRED);
    try {
      expect(await tryLogin(strict, 'viewer')).toBe('/login?error=access_denied');
      expect(await tryLogin(strict, 'editor')).toBe('/login?error=access_denied');
      expect(await tryLogin(strict, IMPOSTOR)).toBe('/login?error=access_denied');
      expect(await tryLogin(strict, 'admin')).toBe('/');

      // A session from before the mapping was required.
      const res = await send(strict, viewer, 'GET', '/api/me');
      expect(res.statusCode).toBe(401);
    } finally {
      await strict.close();
    }
  });
});

describe('a broken actor mapping', () => {
  it.each([
    ['table', 'actor: { table: people, matchColumn: email, idColumn: id }'],
    ['column', 'actor: { table: staff, matchColumn: mail, idColumn: id }'],
  ])('warns about a missing %s, starts, and maps nobody', async (_, actorConfig) => {
    const lines: Record<string, unknown>[] = [];
    const broken = await start(actorConfig, lines);
    try {
      expect(lines).toContainEqual(
        expect.objectContaining({ level: 40, configPath: expect.stringMatching(/^actor\./) }),
      );
      await login(broken, 'admin');
      expect(await sessionUserIds('admin')).toContain(null);
    } finally {
      await broken.close();
    }
  });

  it('fails closed when required', async () => {
    const lines: Record<string, unknown>[] = [];
    const broken = await start(
      'actor: { table: staff, matchColumn: email, idColumn: nope, required: true }',
      lines,
    );
    try {
      expect(lines).toContainEqual(
        expect.objectContaining({ msg: expect.stringContaining('nobody can sign in') }),
      );
      expect(await tryLogin(broken, 'admin')).toBe('/login?error=access_denied');
    } finally {
      await broken.close();
    }
  });

  it('gives no id, rather than failing sign-in, when the table goes away after startup', async () => {
    const lines: Record<string, unknown>[] = [];
    await sqlPool.query('create table temp_staff (id int, email text)');
    await sqlPool.query(`insert into temp_staff values (7, 'admin@example.com')`);
    const target = await start(
      'actor: { table: temp_staff, matchColumn: email, idColumn: id }',
      lines,
    );
    try {
      await sqlPool.query('drop table temp_staff');
      await sqlPool.query(`delete from warden.sessions where subject = 'admin'`);
      await login(target, 'admin');
      expect(await sessionUserIds('admin')).toEqual([null]);
      expect(lines).toContainEqual(
        expect.objectContaining({ msg: 'actor: could not look up the user id' }),
      );
    } finally {
      await target.close();
    }
  });
});
