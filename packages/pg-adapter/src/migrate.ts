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
