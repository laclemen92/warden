import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_EXPORT_ROWS } from '../src/routes/export.js';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

// `viewer` may read but not export. `ops` may export but can't see when users last logged in or
// companies' domains; `admin` sees everything. Both may search the audit log.
const CONFIG = `
tables:
  companies:
    searchable: [name, domain]
    columns:
      domain: { readableBy: [admin] }
  users:
    columns:
      password_hash: { hidden: true }
      last_login_at: { readableBy: [admin] }
  orders:
    deny: [export]
  internal_notes:
    hidden: true
roles:
  viewer: { grants: { '*': [read] } }
  ops: { grants: { '*': [read, export] }, admin: [audit] }
  admin: { grants: { '*': [read, export] }, admin: [audit] }
access:
  groups:
    warden-viewers: [viewer]
    warden-editors: [ops]
    warden-admins: [admin]
`;

type User = 'viewer' | 'editor' | 'admin';

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
const cookies = {} as Record<User, string>;

beforeAll(async () => {
  db = await startPostgres({
    sql: [
      await readExampleSql('basic/schema.sql'),
      await readExampleSql('basic/seed.sql'),
      'create table internal_notes (id int primary key, body text)',
      `create table events (id int primary key);
       insert into events select generate_series(1, ${MAX_EXPORT_ROWS + 1});`,
    ],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  const dir = mkdtempSync(join(tmpdir(), 'warden-export-'));
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

const exportCsv = (user: User | null, entity: string, query: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: `/api/export/${encodeURIComponent(entity)}`,
    query,
    ...(user ? { headers: { cookie: cookies[user] } } : {}),
  });

const exportCount = async () =>
  Number(
    (await sqlPool.query(`select count(*) from warden.audit_log where action = 'export'`)).rows[0]
      .count,
  );

/** Minimal RFC 4180 parser, enough to check what the export wrote. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      cell += c;
    }
  }
  return rows;
}

describe('CSV export', () => {
  it('requires a session', async () => {
    expect((await exportCsv(null, 'users')).statusCode).toBe(401);
  });

  it('requires the export action, and audits nothing when denied', async () => {
    const before = await exportCount();
    expect(await exportCsv('viewer', 'users')).toMatchObject({ statusCode: 403 });
    // A table-level deny beats the `*` grant.
    expect(await exportCsv('admin', 'orders')).toMatchObject({ statusCode: 403 });
    expect(await exportCount()).toBe(before);
  });

  it('treats hidden and missing tables the same', async () => {
    const missing = await exportCsv('admin', 'nope');
    expect(missing.statusCode).toBe(404);
    expect((await exportCsv('admin', 'internal_notes')).body).toBe(missing.body);
  });

  it('exports every matching row with the grid filter, search, and sort', async () => {
    const filter = { field: 'is_active', op: 'eq', value: true };
    const res = await exportCsv('admin', 'users', {
      filter: JSON.stringify(filter),
      q: 'user1',
      sort: '-email',
      columns: 'email,id,last_login_at',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="users-[\w-]+\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.startsWith('﻿')).toBe(true);

    const [header, ...rows] = parseCsv(res.body.slice(1));
    // Entity order, whatever order they were asked for in.
    expect(header).toEqual(['id', 'email', 'last_login_at']);
    const { rows: expected } = await sqlPool.query<{ id: string; email: string; seen: string }>(`
      select id::text, email, coalesce(last_login_at::text, '') as seen from users
      where is_active and (email ilike '%user1%' or full_name ilike '%user1%')
      order by email desc, id`);
    expect(rows).toHaveLength(expected.length);
    expect(rows.map((r) => [r[0], r[1]])).toEqual(expected.map((r) => [r.id, r.email]));
    expect(rows.filter((r) => r[2] === '').length).toBe(expected.filter((r) => !r.seen).length);
  });

  it('only includes fields the user can read', async () => {
    const res = await exportCsv('editor', 'users');
    expect(res.statusCode).toBe(200);
    const [header, ...rows] = parseCsv(res.body.slice(1));
    expect(header).not.toContain('password_hash');
    expect(header).not.toContain('last_login_at');
    expect(header).toContain('email');
    expect(res.body).not.toContain('not-a-real-hash');
    expect(rows).toHaveLength(500);
  });

  it("rejects hidden and unreadable fields exactly like nonexistent ones, wherever they're named", async () => {
    const before = await exportCount();
    for (const query of [
      (f: string) => ({ columns: `email,${f}` }),
      (f: string) => ({ sort: f }),
      (f: string) => ({ filter: JSON.stringify({ field: f, op: 'isNull' }) }),
    ]) {
      const body = async (user: User, field: string) => {
        const res = await exportCsv(user, 'users', query(field));
        expect(res.statusCode, res.body).toBe(400);
        return res.body.replaceAll(field, '<field>');
      };
      const missing = await body('editor', 'no_such_column');
      expect(await body('editor', 'password_hash')).toBe(missing);
      expect(await body('editor', 'last_login_at')).toBe(missing);
      expect(await body('admin', 'password_hash')).toBe(missing);
    }
    expect(await exportCount()).toBe(before);
  });

  it('rejects malformed input', async () => {
    for (const query of [
      { filter: '{nope' },
      { filter: JSON.stringify({ field: 'email', op: 'eq', value: { $ne: 1 } }) },
      { sort: 'metadata' },
      { columns: 'email,email' },
      { columns: '' },
    ]) {
      expect((await exportCsv('admin', 'users', query)).statusCode, JSON.stringify(query)).toBe(
        400,
      );
    }
  });

  it('writes an audit entry, shown to auditors only as far as they can see', async () => {
    const res = await exportCsv('admin', 'users', {
      q: 'User 4',
      sort: '-last_login_at',
      columns: 'id,email,last_login_at',
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await sqlPool.query(
      `select actor_subject, actor_roles, action, entity, record_id, details, request_id
       from warden.audit_log where action = 'export' order by id desc limit 1`,
    );
    const rowCount = parseCsv(res.body.slice(1)).length - 1;
    expect(rows[0]).toEqual({
      actor_subject: 'admin',
      actor_roles: ['admin'],
      action: 'export',
      entity: 'users',
      record_id: null,
      details: {
        rowCount,
        columns: ['id', 'email', 'last_login_at'],
        q: 'User 4',
        searchFields: ['email', 'full_name'],
        sort: '-last_login_at',
      },
      request_id: expect.any(String),
    });

    const search = async (user: User) => {
      const audit = await app.inject({
        method: 'GET',
        url: '/api/audit?action=export&entity=users&limit=1',
        headers: { cookie: cookies[user] },
      });
      expect(audit.statusCode, audit.body).toBe(200);
      return audit.json().items[0];
    };
    expect(await search('admin')).toMatchObject({
      action: 'export',
      details: rows[0].details,
    });
    // ops can't see last_login_at, so the sort on it is left out and the column dropped.
    const redacted = await search('editor');
    expect(redacted.details).toEqual({
      rowCount,
      columns: ['id', 'email'],
      q: 'User 4',
      searchFields: ['email', 'full_name'],
      redacted: true,
    });
    expect(JSON.stringify(redacted)).not.toContain('last_login_at');
  });

  it("hides the search, and how many rows it matched, from auditors who can't see a field it ran over", async () => {
    const auditedExport = async (user: User) => {
      const audit = await app.inject({
        method: 'GET',
        url: '/api/audit?action=export&entity=companies&limit=1',
        headers: { cookie: cookies[user] },
      });
      expect(audit.statusCode, audit.body).toBe(200);
      return audit.json().items[0];
    };
    // The admin's search also ran over domain, which ops can't read.
    let res = await exportCsv('admin', 'companies', { q: 'company7.example', columns: 'id,name' });
    expect(res.statusCode).toBe(200);
    const rowCount = parseCsv(res.body.slice(1)).length - 1;
    expect((await auditedExport('admin')).details).toEqual({
      rowCount,
      columns: ['id', 'name'],
      q: 'company7.example',
      searchFields: ['name', 'domain'],
    });
    const redacted = await auditedExport('editor');
    expect(redacted.details).toEqual({ columns: ['id', 'name'], redacted: true });
    expect(JSON.stringify(redacted)).not.toMatch(/company7|domain/);

    // Ops' own search only ran over what ops can read, so other auditors see all of it.
    res = await exportCsv('editor', 'companies', { q: 'Company 7' });
    expect(res.statusCode).toBe(200);
    expect((await auditedExport('editor')).details).toMatchObject({
      rowCount: parseCsv(res.body.slice(1)).length - 1,
      q: 'Company 7',
      searchFields: ['name'],
    });

    // A redacted filter takes the row count with it, too.
    res = await exportCsv('admin', 'companies', {
      filter: JSON.stringify({ field: 'domain', op: 'isNotNull' }),
    });
    expect(res.statusCode).toBe(200);
    expect((await auditedExport('editor')).details).toEqual({
      columns: ['id', 'name', 'plan', 'created_at'],
      redacted: true,
    });
  });

  it('refuses exports over the row limit, without auditing them', async () => {
    const before = await exportCount();
    const res = await exportCsv('admin', 'events');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/limited to 100,000 rows; this one has 100,001/);
    expect(await exportCount()).toBe(before);
    // Narrowed, it goes through.
    const narrowed = await exportCsv('admin', 'events', {
      filter: JSON.stringify({ field: 'id', op: 'lte', value: 3 }),
    });
    expect(narrowed.body).toBe('﻿id\r\n1\r\n2\r\n3\r\n');
  });

  it('sends nothing when the audit entry cannot be written', async () => {
    await sqlPool.query(`
      create function warden.fail_audit() returns trigger language plpgsql as
        $$ begin raise exception 'audit unavailable'; end; $$;
      create trigger fail_audit before insert on warden.audit_log
        for each row execute function warden.fail_audit();`);
    try {
      const res = await exportCsv('admin', 'users');
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
      expect(res.body).not.toContain('@company');
    } finally {
      await sqlPool.query(`
        drop trigger fail_audit on warden.audit_log;
        drop function warden.fail_audit();`);
    }
  });

  it('defuses spreadsheet formulas in text', async () => {
    await sqlPool.query(
      `update users set full_name = '=HYPERLINK("http://evil.example","x")' where id = 1`,
    );
    const res = await exportCsv('admin', 'users', {
      filter: JSON.stringify({ field: 'id', op: 'eq', value: 1 }),
      columns: 'id,full_name',
    });
    expect(parseCsv(res.body.slice(1))).toEqual([
      ['id', 'full_name'],
      ['1', `'=HYPERLINK("http://evil.example","x")`],
    ]);
  });
});
