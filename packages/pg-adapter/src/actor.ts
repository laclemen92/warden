import type { ActorMapping } from '@wardenhq/core';
import { sql } from 'kysely';
import type { Database } from './database.js';

/** A user's row in the mapped users table: their id, or why there is none. */
export type ActorLookup = { userId: string } | { userId?: undefined; matches: 0 | 'many' };

/**
 * Look up the internal id of the user with `email` (already verified and ASCII-lowercased, see
 * `assignmentEmail`). Only `idColumn` is read, and only rows whose match column is ASCII can
 * match, so a look-alike address stored in the table can't stand in for another. Zero or several
 * matches (or a null id) give no id.
 */
export async function lookupActorUserId(
  db: Database,
  mapping: ActorMapping,
  email: string,
): Promise<ActorLookup> {
  const match = sql.id(mapping.matchColumn);
  const id = sql.id(mapping.idColumn);
  const { rows } = await sql<{ id: string }>`
    select ${id}::text as id from ${sql.id(mapping.schema, mapping.table)}
    where lower(${match}::text) = ${email}
      and ${match}::text !~ ${'[^ -~]'}
      and ${id} is not null
    limit 2`.execute(db);
  if (rows.length === 1) return { userId: rows[0]!.id };
  return { matches: rows.length === 0 ? 0 : 'many' };
}

/** Who a write transaction runs for, for the database's own triggers and defaults to read. */
export interface TransactionActor {
  subject: string;
  email?: string;
  userId?: string;
}

/**
 * Set `warden.actor_id`, `warden.actor_sub` and `warden.actor_email` for the rest of the
 * transaction (`set_config(..., true)`), so they are gone once it ends. Unknown values are empty
 * strings; outside a write, `current_setting(name, true)` is null or empty too.
 */
export async function setActorSettings(trx: Database, actor: TransactionActor): Promise<void> {
  await sql`
    select set_config('warden.actor_id', ${actor.userId ?? ''}, true),
           set_config('warden.actor_sub', ${actor.subject}, true),
           set_config('warden.actor_email', ${actor.email ?? ''}, true)`.execute(trx);
}
