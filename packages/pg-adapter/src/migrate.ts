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
  {
    version: '0003_schema_snapshots',
    sql: `
      -- Baselines for the schema drift page; the newest row is the current baseline.
      create table warden.schema_snapshots (
        id       bigint generated always as identity primary key,
        taken_at timestamptz not null default now(),
        -- OIDC subject of the admin who acknowledged it; null for the one taken at first start.
        taken_by text,
        model    jsonb not null
      );
    `,
  },
  {
    version: '0004_role_assignments',
    sql: `
      -- Roles given to users in the app, on top of the ones config's access rules give them.
      -- Role names aren't checked here: config defines roles, and ones it no longer defines are
      -- ignored rather than deleted, so they come back if the role does.
      create table warden.role_assignments (
        -- Matched against the verified email claim at sign-in and on every request.
        email       text not null check (email = lower(email)),
        role        text not null,
        assigned_by text not null,
        assigned_at timestamptz not null default now(),
        primary key (email, role)
      );
    `,
  },
  {
    version: '0005_saved_views',
    sql: `
      create table warden.saved_views (
        id            bigint generated always as identity primary key,
        -- Entity key, as in /api/entities/:entity.
        entity        text not null,
        name          text not null,
        owner_subject text not null,
        -- The owner's name or email when they saved it, to show next to shared views.
        owner_name    text,
        shared        boolean not null default false,
        state         jsonb not null,
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now()
      );
      create unique index saved_views_name_idx
        on warden.saved_views (entity, owner_subject, lower(name));
      create index saved_views_shared_idx on warden.saved_views (entity) where shared;
    `,
  },
  {
    version: '0006_audit_details',
    sql: `
      -- What an action that changes no row did, e.g. an export's filter and row count.
      alter table warden.audit_log add column details jsonb;
    `,
  },
  {
    version: '0007_session_id_token',
    sql: `
      -- Sent back to the IdP as id_token_hint when the user logs out. It only identifies the
      -- user to the IdP; Warden never accepts it as a credential.
      alter table warden.sessions add column id_token text;
    `,
  },
  {
    version: '0008_audit_written',
    sql: `
      -- The fields a create or update set. The rest of its diff is what the database changed
      -- itself (defaults, triggers), which doesn't make the write visible to readers of those
      -- fields. Null for other actions and for entries written before this column existed.
      alter table warden.audit_log add column written text[];
    `,
  },
  {
    version: '0009_session_verified_email',
    sql: `
      -- Sessions now store an email only when the IdP verified it; older ones stored any, which
      -- the Roles page and session revocations would show. Rows are short-lived, so dropping the
      -- unverified ones (and any under requireVerifiedEmail: false until they sign in again) is
      -- simpler than keeping them.
      update warden.sessions set email = null
      where claims->'email_verified' is distinct from 'true'::jsonb
        and claims->'email_verified' is distinct from '"true"'::jsonb;
    `,
  },
  {
    version: '0010_session_sealed_id_token',
    sql: `
      -- ID tokens are now stored encrypted under a key only the browser's session cookie can
      -- derive. The plaintext ones stored before are dropped; those users just log out without
      -- an id_token_hint.
      update warden.sessions set id_token = null;
    `,
  },
  {
    version: '0011_actor_user_id',
    sql: `
      -- The internal user id config's \`actor\` mapped the user to at sign-in, as text whatever the
      -- users table's id type. Null without a mapping or a match. \`actor_mapping\` identifies the
      -- mapping it was resolved under, so the id is ignored once \`actor\` points elsewhere.
      alter table warden.sessions add column actor_user_id text, add column actor_mapping text;
      alter table warden.audit_log add column actor_user_id text;
    `,
  },
  {
    version: '0012_session_api_tokens',
    sql: `
      -- The access token (and refresh token, with offline_access) for the API audience login
      -- requests, encrypted like id_token under a key only the session cookie can derive.
      alter table warden.sessions
        add column access_token text,
        add column refresh_token text,
        add column access_token_expires_at timestamptz;
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

/**
 * Whether the connected role could switch off the audit log's append-only triggers: it is a
 * superuser, or owns (directly or through a role it belongs to) `warden.audit_log` (so it can
 * disable them), the `warden` schema (so it can drop the table), or the trigger function (so
 * `create or replace` can make it a no-op). False when the table doesn't exist.
 */
export async function canDisableAuditTriggers(db: Database): Promise<boolean> {
  const { rows } = await sql<{ can: boolean }>`
    select r.rolsuper
           or pg_has_role(current_user, c.relowner, 'MEMBER')
           or pg_has_role(current_user, n.nspowner, 'MEMBER')
           or coalesce(pg_has_role(current_user, p.proowner, 'MEMBER'), false) as can
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.rolname = current_user
    left join pg_proc p on p.oid = to_regprocedure(${`${WARDEN_SCHEMA}.audit_log_append_only()`})
    where c.oid = to_regclass(${`${WARDEN_SCHEMA}.audit_log`})`.execute(db);
  return rows[0]?.can ?? false;
}
