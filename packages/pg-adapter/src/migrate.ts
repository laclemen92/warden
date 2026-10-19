import { sql } from 'kysely';
import type { Database } from './database.js';
import { WARDEN_SCHEMA } from './introspect.js';

export interface Migration {
  /** Applied in ascending order; never renumber or edit one that has shipped. */
  version: string;
  sql: string;
}

/** Migrations for Warden's own `warden` schema. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: '0001_sessions',
    sql: `
      create table warden.sessions (
        -- sha256 of the cookie token, so a leaked table can't be replayed as live sessions.
        token_hash   bytea primary key,
        subject      text not null,
        email        text,
        name         text,
        claims       jsonb not null default '{}',
        created_at   timestamptz not null default now(),
        last_seen_at timestamptz not null default now()
      );
      create index sessions_created_at_idx on warden.sessions (created_at);
      create index sessions_last_seen_at_idx on warden.sessions (last_seen_at);
    `,
  },
  {
    version: '0002_audit_log',
    sql: `
      create table warden.audit_log (
        id            bigint generated always as identity primary key,
        occurred_at   timestamptz not null default now(),
        request_id    text,
        actor_subject text not null,
        actor_email   text,
        actor_roles   text[] not null default '{}',
        -- Free text rather than an enum: custom actions add their own names.
        action        text not null,
        entity        text not null,
        -- The opaque record id the API uses, plus the raw key columns.
        record_id     text,
        primary_key   jsonb,
        before        jsonb,
        after         jsonb,
        diff          jsonb,
        reason        text,
        -- Groups the rows touched by one custom action under a parent entry.
        parent_id     bigint references warden.audit_log (id)
      );
      create index audit_log_record_idx on warden.audit_log (entity, record_id, id desc);
      create index audit_log_occurred_at_idx on warden.audit_log (occurred_at);
      create index audit_log_actor_idx on warden.audit_log (actor_subject, occurred_at);
      create index audit_log_parent_idx on warden.audit_log (parent_id) where parent_id is not null;

      -- Append-only even for the table owner, who bypasses grants. Dropping the triggers takes
      -- a deliberate DDL statement, which the runtime role shouldn't be able to run at all.
      create function warden.audit_log_append_only() returns trigger
        language plpgsql as $$
        begin
          raise exception 'warden.audit_log is append-only (% denied)', tg_op
            using errcode = 'insufficient_privilege';
        end;
        $$;
      create trigger audit_log_no_update_delete
        before update or delete on warden.audit_log
        for each row execute function warden.audit_log_append_only();
      create trigger audit_log_no_truncate
        before truncate on warden.audit_log
        for each statement execute function warden.audit_log_append_only();
    `,
  },
];

// Arbitrary constant shared by every Warden instance, so replicas don't migrate concurrently.
const LOCK_ID = 0x77617264; // "ward"

/**
 * Apply pending migrations in one transaction under an advisory lock. Returns the versions
 * applied by this call (empty when already up to date).
 */
export async function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${LOCK_ID})`.execute(trx);
    await sql`create schema if not exists ${sql.id(WARDEN_SCHEMA)}`.execute(trx);
    await sql`
      create table if not exists ${sql.id(WARDEN_SCHEMA, 'schema_migrations')} (
        version    text primary key,
        applied_at timestamptz not null default now()
      )`.execute(trx);

    const { rows } = await sql<{ version: string }>`
      select version from ${sql.id(WARDEN_SCHEMA, 'schema_migrations')}`.execute(trx);
    const applied = new Set(rows.map((r) => r.version));

    const pending = [...migrations]
      .sort((a, b) => a.version.localeCompare(b.version))
      .filter((m) => !applied.has(m.version));
    for (const migration of pending) {
      await sql.raw(migration.sql).execute(trx);
      await sql`
        insert into ${sql.id(WARDEN_SCHEMA, 'schema_migrations')} (version)
        values (${migration.version})`.execute(trx);
    }
    return pending.map((m) => m.version);
  });
}

/** Versions in `migrations` not yet applied, for refusing to start against a stale schema. */
export async function pendingMigrations(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  const { rows: exists } = await sql<{ table: string | null }>`
    select to_regclass(${`${WARDEN_SCHEMA}.schema_migrations`})::text as table`.execute(db);
  const applied = new Set<string>();
  if (exists[0]?.table) {
    const { rows } = await sql<{ version: string }>`
      select version from ${sql.id(WARDEN_SCHEMA, 'schema_migrations')}`.execute(db);
    for (const row of rows) applied.add(row.version);
  }
  return migrations
    .map((m) => m.version)
    .filter((v) => !applied.has(v))
    .sort();
}
