import type { ViewState } from '@wardenhq/core';
import { sql } from 'kysely';
import type { Database } from './database.js';
import { WARDEN_SCHEMA } from './introspect.js';

const SAVED_VIEWS = sql.id(WARDEN_SCHEMA, 'saved_views');

/** A saved grid view as stored. The state is unchecked: validate it before using it. */
export interface SavedView {
  /** int8, so a string like every other bigint Warden reads. */
  id: string;
  entity: string;
  name: string;
  ownerSubject: string;
  ownerName: string | null;
  shared: boolean;
  state: ViewState;
  createdAt: string;
  updatedAt: string;
}

export interface NewSavedView {
  entity: string;
  name: string;
  ownerSubject: string;
  ownerName?: string;
  shared: boolean;
  state: ViewState;
}

export interface SavedViewChanges {
  name?: string;
  shared?: boolean;
  state?: ViewState;
}

export type SavedViewResult =
  { ok: true; view: SavedView } | { ok: false; reason: 'duplicate' | 'not_found' };

const COLUMNS = sql`
  id, entity, name, owner_subject as "ownerSubject", owner_name as "ownerName", shared, state,
  created_at as "createdAt", updated_at as "updatedAt"`;

// unique_violation: the owner already has a view with this name on this entity.
const isDuplicate = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';

/** The views of `entity` that `subject` owns, and every shared view of it, by name. */
export async function listSavedViews(
  db: Database,
  { entity, subject }: { entity: string; subject: string },
): Promise<SavedView[]> {
  const { rows } = await sql<SavedView>`
    select ${COLUMNS} from ${SAVED_VIEWS}
    where entity = ${entity} and (owner_subject = ${subject} or shared)
    order by lower(name), id`.execute(db);
  return rows;
}

/** Every shared view, of every entity. */
export async function listSharedViews(db: Database): Promise<SavedView[]> {
  const { rows } = await sql<SavedView>`
    select ${COLUMNS} from ${SAVED_VIEWS} where shared
    order by entity, lower(name), id`.execute(db);
  return rows;
}

export async function getSavedView(db: Database, id: string): Promise<SavedView | undefined> {
  const { rows } = await sql<SavedView>`
    select ${COLUMNS} from ${SAVED_VIEWS} where id = ${id}`.execute(db);
  return rows[0];
}

export async function createSavedView(db: Database, view: NewSavedView): Promise<SavedViewResult> {
  try {
    const { rows } = await sql<SavedView>`
      insert into ${SAVED_VIEWS} (entity, name, owner_subject, owner_name, shared, state)
      values (${view.entity}, ${view.name}, ${view.ownerSubject}, ${view.ownerName ?? null},
              ${view.shared}, ${JSON.stringify(view.state)}::jsonb)
      returning ${COLUMNS}`.execute(db);
    return { ok: true, view: rows[0]! };
  } catch (err) {
    if (isDuplicate(err)) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

/**
 * Change a view. `expectShared` is the sharing the caller's permission check was based on: if
 * the view has been shared or unshared since, nothing changes and the view counts as not found.
 */
export async function updateSavedView(
  db: Database,
  id: string,
  changes: SavedViewChanges,
  { expectShared }: { expectShared: boolean },
): Promise<SavedViewResult> {
  const sets = [
    sql`updated_at = now()`,
    ...(changes.name !== undefined ? [sql`name = ${changes.name}`] : []),
    ...(changes.shared !== undefined ? [sql`shared = ${changes.shared}`] : []),
    ...(changes.state !== undefined ? [sql`state = ${JSON.stringify(changes.state)}::jsonb`] : []),
  ];
  try {
    const { rows } = await sql<SavedView>`
      update ${SAVED_VIEWS} set ${sql.join(sets)}
      where id = ${id} and shared = ${expectShared}
      returning ${COLUMNS}`.execute(db);
    return rows[0] ? { ok: true, view: rows[0] } : { ok: false, reason: 'not_found' };
  } catch (err) {
    if (isDuplicate(err)) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

/** Delete a view; see {@link updateSavedView} for `expectShared`. False when nothing matched. */
export async function deleteSavedView(
  db: Database,
  id: string,
  { expectShared }: { expectShared: boolean },
): Promise<boolean> {
  const result = await sql`
    delete from ${SAVED_VIEWS} where id = ${id} and shared = ${expectShared}`.execute(db);
  return (result.numAffectedRows ?? 0n) > 0n;
}
