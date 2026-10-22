import { Writable } from 'node:stream';
import { ConfigError } from '@wardenhq/config';
import type { AuditEntry } from '@wardenhq/core';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';

const SCHEMA = `
  create table staff (id bigint primary key, email text not null);
  insert into staff values (101, 'admin@example.com'), (102, 'editor@example.com');

  create table certificates (
    id          serial primary key,
    name        text not null,
    deleted_at  timestamptz,
    deleted_by  bigint
  );
  create table notes (
    id          serial primary key,
    body        text not null,
    is_deleted  boolean not null default false
  );
  -- Soft delete is configured with a column that can't hold it, so it falls back to hard delete.
  create table drafts (id serial primary key, body text, deleted_at text);
  create table lines (
    id              serial primary key,
    certificate_id  int references certificates (id) on delete cascade
  );
`;

const ACCESS = `
access:
  groups:
    warden-viewers: [viewer]
    warden-editors: [editor]
    warden-admins: [admin]
`;

// Admin may delete and restore; the editor may delete but not update (so not restore); the
// viewer may only read. Hard delete stays off everywhere.
const CONFIG = `
tables:
  staff: { hidden: true }
  certificates:
    softDelete: { column: deleted_at, by: deleted_by }
    columns: { deleted_at: { readOnly: true }, deleted_by: { readOnly: true } }
  notes:
    softDelete: { column: is_deleted }
    requireReason: []
  drafts:
    softDelete: { column: deleted_at }
  lines:
    deny: [delete]
actor: { table: staff, matchColumn: email, idColumn: id }
roles:
  viewer: { grants: { '*': [read] } }
  editor:
    grants:
      '*': [read]
      certificates: [delete]
      notes: [delete]
      lines: [delete]
  admin:
    grants:
      '*': [read, create, update, export]
      certificates: [delete]
      notes: [delete]
      drafts: [delete]
    admin: [audit]
${ACCESS}`;

const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };
const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'Not Found' };
const REASON = 'certificate was revoked';
type User = 'viewer' | 'editor' | 'admin';
type Warden = Awaited<ReturnType<typeof createWarden>>;

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Warden;
let warnings: [unknown, unknown][];
const cookies = {} as Record<User, string>;

beforeAll(async () => {
  db = await startPostgres({ sql: [SCHEMA] });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  warnings = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      const line = JSON.parse(String(chunk)) as { msg?: string; configPath?: string };
      if (String(line.msg).startsWith('config: ')) warnings.push([line.configPath, line.msg]);
      done();
    },
  });
  app = await createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: writeConfig(CONFIG), ...authEnv(idp) },
    logger: { level: 'warn', stream },
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

const insert = async (sql: string) =>
  String((await sqlPool.query<{ id: number }>(`${sql} returning id`)).rows[0]!.id);
const rowOf = async (table: string, id: string) =>
  (await sqlPool.query(`select * from ${table} where id = $1`, [id])).rows[0] as
    Record<string, unknown> | undefined;
const auditOf = async (entity: string, id: string) =>
  (
    await sqlPool.query(
      `select action, details, reason, actor_user_id from warden.audit_log
       where entity = $1 and record_id = $2 order by id`,
      [entity, id],
    )
  ).rows;

const json = { 'content-type': 'application/json' };
const remove = (user: User, table: string, id: string, body: object = { reason: REASON }) =>
  app.inject({
    method: 'DELETE',
    url: `/api/entities/${table}/${id}`,
    headers: { cookie: cookies[user], ...json },
    payload: body,
  });
const restore = (user: User, table: string, id: string, body: object = { reason: REASON }) =>
  app.inject({
    method: 'POST',
    url: `/api/entities/${table}/${id}/restore`,
    headers: { cookie: cookies[user], ...json },
    payload: body,
  });
const list = async (user: User, table: string, query = '') => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/entities/${table}?count=true&limit=500${query}`,
    headers: { cookie: cookies[user] },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{ items: { id: string }[]; total: number }>();
  return { ids: body.items.map((i) => i.id), total: body.total };
};

describe('soft delete with a timestamp column', () => {
  it('leaves the row in place with the column and `by` set, and one audit entry', async () => {
    const id = await insert(`insert into certificates (name) values ('cert-1')`);
    const res = await remove('admin', 'certificates', id);
    expect(res.statusCode, res.body).toBe(204);

    const row = await rowOf('certificates', id);
    expect(row).toMatchObject({ name: 'cert-1', deleted_by: '101' });
    expect(row?.deleted_at).not.toBeNull();
    expect(await auditOf('certificates', id)).toEqual([
      {
        action: 'delete',
        details: { softDelete: 'delete' },
        reason: REASON,
        actor_user_id: '101',
      },
    ]);
  });

  it('leaves deleted rows out of the default list and its count', async () => {
    const live = await insert(`insert into certificates (name) values ('live')`);
    const gone = await insert(`insert into certificates (name) values ('gone')`);
    expect((await remove('admin', 'certificates', gone)).statusCode).toBe(204);

    const byDefault = await list('viewer', 'certificates');
    expect(byDefault.ids).toContain(live);
    expect(byDefault.ids).not.toContain(gone);
    const { rows } = await sqlPool.query(
      'select count(*)::int as n from certificates where deleted_at is null',
    );
    expect(byDefault.total).toBe(rows[0].n);

    const all = await list('viewer', 'certificates', '&deleted=include');
    expect(all.ids).toEqual(expect.arrayContaining([live, gone]));
    const only = await list('viewer', 'certificates', '&deleted=only');
    expect(only.ids).toContain(gone);
    expect(only.ids).not.toContain(live);

    // The record itself still reads, marked by its column.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/entities/certificates/${gone}`,
      headers: { cookie: cookies.viewer },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().values.deleted_at).not.toBeNull();
  });

  it('rejects a bad deleted mode', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/entities/certificates?deleted=all',
      headers: { cookie: cookies.viewer },
    });
    expect(res.statusCode).toBe(400);
  });

  it('leaves deleted rows out of exports unless asked', async () => {
    const gone = await insert(
      `insert into certificates (name, deleted_at) values ('exported-gone', now())`,
    );
    const csv = async (query: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/export/certificates?columns=id,name${query}`,
        headers: { cookie: cookies.admin },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.body;
    };
    expect(await csv('')).not.toContain('exported-gone');
    expect(await csv('&deleted=include')).toContain(`${gone},exported-gone`);
  });

  it('treats deleting a deleted row as not found, changing nothing', async () => {
    const id = await insert(`insert into certificates (name) values ('twice')`);
    expect((await remove('admin', 'certificates', id)).statusCode).toBe(204);
    const before = await rowOf('certificates', id);
    const again = await remove('editor', 'certificates', id);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual(NOT_FOUND);
    expect(await rowOf('certificates', id)).toEqual(before);
    expect(await auditOf('certificates', id)).toHaveLength(1);
  });

  it('requires a reason, as for any delete', async () => {
    const id = await insert(`insert into certificates (name) values ('no reason')`);
    const res = await remove('admin', 'certificates', id, {});
    expect(res.statusCode).toBe(400);
    expect((await rowOf('certificates', id))?.deleted_at).toBeNull();
  });

  it('checks the version', async () => {
    const id = await insert(`insert into certificates (name) values ('versioned')`);
    const res = await remove('admin', 'certificates', id, { reason: REASON, version: 'stale' });
    expect(res.statusCode).toBe(409);
    expect((await rowOf('certificates', id))?.deleted_at).toBeNull();
  });

  it('restores a deleted row for roles granted update, clearing the column and `by`', async () => {
    const id = await insert(`insert into certificates (name) values ('restored')`);
    expect((await remove('editor', 'certificates', id)).statusCode).toBe(204);
    expect(await rowOf('certificates', id)).toMatchObject({ deleted_by: '102' });

    // The editor may delete but not update.
    const denied = await restore('editor', 'certificates', id);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual(FORBIDDEN);
    expect((await restore('viewer', 'certificates', id)).statusCode).toBe(403);
    expect((await restore('admin', 'certificates', id, {})).statusCode).toBe(400);

    const res = await restore('admin', 'certificates', id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().values).toMatchObject({ deleted_at: null, deleted_by: null });
    expect(await rowOf('certificates', id)).toMatchObject({ deleted_at: null, deleted_by: null });
    expect((await list('viewer', 'certificates')).ids).toContain(id);
    expect(await auditOf('certificates', id)).toEqual([
      expect.objectContaining({ action: 'delete', details: { softDelete: 'delete' } }),
      expect.objectContaining({
        action: 'update',
        details: { softDelete: 'restore' },
        reason: REASON,
      }),
    ]);

    // A live row has nothing to restore.
    const again = await restore('admin', 'certificates', id);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual(NOT_FOUND);
  });

  it('shows the flagged delete and restore in the record history', async () => {
    const id = await insert(`insert into certificates (name) values ('history')`);
    await remove('admin', 'certificates', id);
    await restore('admin', 'certificates', id);
    const res = await app.inject({
      method: 'GET',
      url: `/api/entities/certificates/${id}/history`,
      headers: { cookie: cookies.viewer },
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: AuditEntry[] }>().items;
    expect(items.map((e) => [e.action, e.details, e.reason])).toEqual([
      ['update', { softDelete: 'restore' }, REASON],
      ['delete', { softDelete: 'delete' }, REASON],
    ]);
  });
});

describe('soft delete with a boolean column', () => {
  it('sets it to true, hides the row, and restores it to false', async () => {
    const id = await insert(`insert into notes (body) values ('a note')`);
    expect((await remove('editor', 'notes', id, {})).statusCode).toBe(204);
    expect(await rowOf('notes', id)).toMatchObject({ is_deleted: true });
    expect((await list('viewer', 'notes')).ids).not.toContain(id);
    expect(await auditOf('notes', id)).toEqual([
      { action: 'delete', details: { softDelete: 'delete' }, reason: null, actor_user_id: '102' },
    ]);

    expect((await restore('admin', 'notes', id, {})).statusCode).toBe(200);
    expect(await rowOf('notes', id)).toMatchObject({ is_deleted: false });
    expect((await list('viewer', 'notes')).ids).toContain(id);
  });
});

describe('the deny paths', () => {
  it('refuses roles without a delete grant on the table', async () => {
    const id = await insert(`insert into certificates (name) values ('kept')`);
    const res = await remove('viewer', 'certificates', id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN);
    expect((await rowOf('certificates', id))?.deleted_at).toBeNull();
  });

  it('lets a table deny beat the grant', async () => {
    const id = await insert(`insert into lines (certificate_id) values (null)`);
    const res = await remove('editor', 'lines', id);
    expect(res.statusCode).toBe(403);
    expect(await rowOf('lines', id)).toBeDefined();
  });

  it('falls back to no delete at all when the column does not fit, with a warning', async () => {
    const id = await insert(`insert into drafts (body) values ('draft')`);
    const res = await remove('admin', 'drafts', id);
    expect(res.statusCode).toBe(403);
    expect(await rowOf('drafts', id)).toBeDefined();
    expect(warnings).toContainEqual([
      'tables.drafts.softDelete.column',
      'config: column "deleted_at" is text; expected a timestamp or boolean; soft delete is off for this table',
    ]);
    const schema = await app.inject({
      method: 'GET',
      url: '/api/schema',
      headers: { cookie: cookies.admin },
    });
    const entities = schema.json<{ entities: { key: string; softDelete?: unknown }[] }>().entities;
    expect(entities.find((e) => e.key === 'drafts')?.softDelete).toBeUndefined();
    expect(entities.find((e) => e.key === 'certificates')?.softDelete).toEqual({
      column: 'deleted_at',
      kind: 'timestamp',
      by: 'deleted_by',
    });
  });

  it('404s restoring on a table without soft delete, or a row that does not exist', async () => {
    const id = await insert(`insert into drafts (body) values ('draft')`);
    expect((await restore('admin', 'drafts', id)).json()).toEqual(NOT_FOUND);
    expect((await restore('admin', 'certificates', '999999')).json()).toEqual(NOT_FOUND);
    expect((await restore('admin', 'staff', '101')).json()).toEqual(NOT_FOUND);
  });

  it('offers delete in capabilities while hard delete stays off', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: { cookie: cookies.editor },
    });
    const { entities } = res.json<{ entities: Record<string, { actions: string[] }> }>();
    expect(entities.certificates?.actions).toEqual(['read', 'delete']);
    expect(entities.drafts?.actions).toEqual(['read']);
  });

  it("doesn't warn about the cascade a soft delete never runs", () => {
    expect(warnings.map(([path]) => path)).not.toContain('tables.certificates');
  });

  it('fails startup when config hides the soft delete column', async () => {
    const hidden = CONFIG.replace(
      'columns: { deleted_at: { readOnly: true }, deleted_by: { readOnly: true } }',
      'columns: { deleted_at: { hidden: true } }',
    );
    await expect(
      createWarden({
        env: {
          DATABASE_URL: db.connectionString,
          WARDEN_CONFIG: writeConfig(hidden),
          ...authEnv(idp),
        },
      }),
    ).rejects.toThrow(ConfigError);
  });
});
