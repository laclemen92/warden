import { readFile } from 'node:fs/promises';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acknowledgeSchemaSnapshot,
  assignRole,
  canDisableAuditTriggers,
  createDatabase,
  ensureSchemaSnapshot,
  migrate,
  MIGRATIONS,
  pendingMigrations,
  type DatabaseHandle,
  unassignRole,
} from '../src/index.js';

let pgContainer: TestDatabase;
let handle: DatabaseHandle;
let appConnectionString: string;

const DOCS = new URL('../../../docs/database.md', import.meta.url);

/** The grant script exactly as docs/database.md shows it, so the docs can't drift. */
async function documentedGrants(): Promise<string> {
  const doc = await readFile(DOCS, 'utf8');
  const match = /<!-- runtime-grants -->\s*```sql\n([\s\S]*?)```/.exec(doc);
  if (!match?.[1]) throw new Error('runtime grants block not found in docs/database.md');
  return match[1];
}

// The append-only trigger also raises 42501, so match the message to prove the grants did it.
const DENIED = {
  code: '42501',
  message: expect.stringMatching(/^(permission denied|must be owner)/),
};

const insertEntry = `
  insert into warden.audit_log (actor_subject, action, entity, record_id, after)
  values ('editor', 'create', 'users', '1', '{"id": 1}') returning id`;

beforeAll(async () => {
  pgContainer = await startPostgres();
  handle = createDatabase({ connectionString: pgContainer.connectionString });
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

describe('pendingMigrations', () => {
  it('lists every migration before the schema exists and none after migrating', async () => {
    expect(await pendingMigrations(handle.db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await canDisableAuditTriggers(handle.db)).toBe(false);
    await migrate(handle.db);
    expect(await pendingMigrations(handle.db)).toEqual([]);
    expect(
      await pendingMigrations(handle.db, [...MIGRATIONS, { version: '9999_next', sql: '' }]),
    ).toEqual(['9999_next']);
  });
});

describe('canDisableAuditTriggers', () => {
  it('is true for the role that created the audit log', async () => {
    await migrate(handle.db);
    expect(await canDisableAuditTriggers(handle.db)).toBe(true);
  });
});

describe('audit_log', () => {
  it('accepts inserts with defaults filled in', async () => {
    const { rows } = await sql<{ id: string }>`${sql.raw(insertEntry)}`.execute(handle.db);
    const entry = await sql<Record<string, unknown>>`
      select * from warden.audit_log where id = ${rows[0]!.id}`.execute(handle.db);
    expect(entry.rows[0]).toMatchObject({
      actor_subject: 'editor',
      actor_roles: [],
      action: 'create',
      before: null,
      after: { id: 1 },
      parent_id: null,
    });
    expect(entry.rows[0]!.occurred_at).toEqual(expect.any(String));
  });

  it.each([
    ['update', "update warden.audit_log set reason = 'tampered'"],
    ['delete', 'delete from warden.audit_log'],
    ['truncate', 'truncate warden.audit_log'],
  ])('rejects %s even from the table owner', async (op, statement) => {
    await expect(sql.raw(statement).execute(handle.db)).rejects.toThrow(
      new RegExp(`append-only \\(${op.toUpperCase()} denied\\)`),
    );
    const { rows } = await sql`select 1 from warden.audit_log`.execute(handle.db);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('documented runtime grants', () => {
  let app: pg.Client;

  beforeAll(async () => {
    await migrate(handle.db);
    await sql.raw(`create role warden_app login password 'app'`).execute(handle.db);
    await sql.raw(await documentedGrants()).execute(handle.db);
    // Re-running after an upgrade must work too.
    await sql.raw(await documentedGrants()).execute(handle.db);

    const url = new URL(pgContainer.connectionString);
    url.username = 'warden_app';
    url.password = 'app';
    appConnectionString = url.href;
    app = new pg.Client({ connectionString: appConnectionString });
    await app.connect();
  });

  afterAll(async () => {
    await app?.end();
  });

  it('lets the runtime role append to and read the audit log', async () => {
    const { rows } = await app.query<{ id: string }>(insertEntry);
    const read = await app.query('select action from warden.audit_log where id = $1', [
      rows[0]!.id,
    ]);
    expect(read.rows).toEqual([{ action: 'create' }]);
  });

  it.each([
    "update warden.audit_log set reason = 'tampered'",
    'delete from warden.audit_log',
    'truncate warden.audit_log',
    'drop trigger audit_log_no_update_delete on warden.audit_log',
    'alter table warden.audit_log disable trigger all',
    'drop table warden.audit_log',
    'create table warden.x (id int)',
  ])('denies the runtime role: %s', async (statement) => {
    await expect(app.query(statement)).rejects.toMatchObject(DENIED);
  });

  it('reports that the runtime role cannot disable the audit triggers', async () => {
    const appHandle = createDatabase({ connectionString: appConnectionString });
    try {
      expect(await canDisableAuditTriggers(appHandle.db)).toBe(false);
    } finally {
      await appHandle.close();
    }
  });

  it.each([
    ['the warden schema', 'schema warden'],
    ['the trigger function', 'function warden.audit_log_append_only()'],
  ])('reports that a role owning %s can disable them', async (_, object) => {
    const { rows } = await sql<{ owner: string }>`select current_user as owner`.execute(handle.db);
    const appHandle = createDatabase({ connectionString: appConnectionString });
    try {
      await sql.raw(`alter ${object} owner to warden_app`).execute(handle.db);
      expect(await canDisableAuditTriggers(appHandle.db)).toBe(true);
    } finally {
      await sql.raw(`alter ${object} owner to "${rows[0]!.owner}"`).execute(handle.db);
      // Handing ownership back drops the grants the runtime role held as owner.
      await sql.raw(await documentedGrants()).execute(handle.db);
      await appHandle.close();
    }
    const again = createDatabase({ connectionString: appConnectionString });
    try {
      expect(await canDisableAuditTriggers(again.db)).toBe(false);
    } finally {
      await again.close();
    }
  });

  it('reports that a member of the owner role can disable them', async () => {
    const { rows } = await sql<{ owner: string }>`
      select tableowner as owner from pg_tables
      where schemaname = 'warden' and tablename = 'audit_log'`.execute(handle.db);
    await sql.raw(`create role warden_member login password 'm' nosuperuser`).execute(handle.db);
    await sql.raw(`grant "${rows[0]!.owner}" to warden_member`).execute(handle.db);
    const url = new URL(pgContainer.connectionString);
    url.username = 'warden_member';
    url.password = 'm';
    const memberHandle = createDatabase({ connectionString: url.href });
    try {
      expect(await canDisableAuditTriggers(memberHandle.db)).toBe(true);
    } finally {
      await memberHandle.close();
    }
  });

  it('lets the runtime role use sessions and check migrations', async () => {
    await app.query(`insert into warden.sessions (token_hash, subject) values ('\\x01', 'a')`);
    await app.query(`update warden.sessions set last_seen_at = now()`);
    await app.query(`delete from warden.sessions`);

    const appHandle = createDatabase({ connectionString: appConnectionString });
    try {
      expect(await pendingMigrations(appHandle.db)).toEqual([]);
    } finally {
      await appHandle.close();
    }
  });

  it('lets the runtime role record and acknowledge schema snapshots', async () => {
    const appHandle = createDatabase({ connectionString: appConnectionString });
    const model = { tables: [], enums: [] };
    try {
      const first = await ensureSchemaSnapshot(appHandle.db, model);
      const next = await acknowledgeSchemaSnapshot(appHandle.db, {
        model,
        expectedId: first.id,
        actor: { subject: 'admin', roles: ['admin'] },
        drift: {},
      });
      expect(next?.takenBy).toBe('admin');
    } finally {
      await appHandle.close();
    }
    await expect(app.query('delete from warden.schema_snapshots')).rejects.toMatchObject(DENIED);
  });

  it('lets the runtime role assign and unassign roles', async () => {
    const appHandle = createDatabase({ connectionString: appConnectionString });
    const change = {
      email: 'grant@example.com',
      role: 'ops',
      actor: { subject: 'admin', roles: [] },
    };
    try {
      expect(await assignRole(appHandle.db, change)).toBeDefined();
      expect(await unassignRole(appHandle.db, change)).toBeDefined();
    } finally {
      await appHandle.close();
    }
  });

  it('lets the runtime role manage saved views', async () => {
    const { rows } = await app.query<{ id: string }>(
      `insert into warden.saved_views (entity, name, owner_subject, state)
       values ('users', 'Mine', 'a', '{}') returning id`,
    );
    await app.query(`update warden.saved_views set shared = true where id = $1`, [rows[0]!.id]);
    await app.query(`delete from warden.saved_views where id = $1`, [rows[0]!.id]);
  });
});
