import { createHash } from 'node:crypto';
import { entityFor, type Entity, type Field, type Filter } from '@wardenhq/core';
import { sql } from 'kysely';
import type { Database } from './database.js';
import { compileFilter } from './filter.js';
import { entityTable, type Row } from './rows.js';

export type WriteAction = 'create' | 'update' | 'delete';

export interface WriteChange {
  action: WriteAction;
  entity: Entity;
  /** The row before the change; null for `create`. */
  before: Row | null;
  /** The row after the change; null for `delete`. */
  after: Row | null;
}

/**
 * Runs inside the write's transaction, after the change and before commit. Throwing rolls the
 * write back, which is what lets the audit log record every write or none.
 */
export type WriteHook = (trx: Database, change: WriteChange) => Promise<void>;

export interface WriteOptions {
  onWrite?: WriteHook;
}

export interface VersionCheck {
  /** The version the client last read. */
  version: string;
  /**
   * The entity the client read the version through, when it saw fewer fields than are written
   * (field-level read rules). Changes to fields it can't see then aren't conflicts.
   */
  versionEntity?: Entity;
}

export type WriteResult = { ok: true; row: Row } | { ok: false; reason: 'notFound' | 'conflict' };

const ALIAS = 't';
const table = (entity: Entity) => sql`${sql.id(entity.schema, entity.name)} as ${sql.id(ALIAS)}`;
// As in reads, `only` keeps inheritance children (separate entities) out of locks, updates, and
// deletes, except on partitioned tables (see `entityTable`). Inserts need no `only`: they always
// land in the named table, or are routed to its partition.
const entityRows = (entity: Entity) => sql`${entityTable(entity)} as ${sql.id(ALIAS)}`;
// As in reads, only exposed fields are selected, so hidden columns never leave the database.
const selection = (entity: Entity) => sql.join(entity.fields.map((f) => sql.id(ALIAS, f.name)));
const returning = (entity: Entity) => sql`returning ${selection(entity)}`;

/**
 * Opaque token that changes whenever an exposed field of the row changes. Clients send back the
 * version they read, and an update made against a different one is a conflict.
 */
export function rowVersion(entity: Entity, row: Row): string {
  const values = entity.fields.map((f) => row[f.name] ?? null);
  return createHash('sha256').update(JSON.stringify(values)).digest('base64url').slice(0, 22);
}

const isJson = (f: Field) => f.dataType === 'json' || f.dataType === 'jsonb';
const toJson = (value: unknown) => (value === null ? null : JSON.stringify(value));

/**
 * Bind value for a validated field value. node-postgres would send a JS array as a Postgres
 * array and a string as-is, so JSON documents are serialized here.
 */
function bindValue(f: Field, value: unknown): unknown {
  if (!isJson(f)) return value;
  return f.isArray && Array.isArray(value) ? value.map(toJson) : toJson(value);
}

/** Field values from `validateRecord`, which only admits the entity's writable fields. */
function assignments(entity: Entity, values: Record<string, unknown>) {
  const fields = new Map(entity.fields.map((f) => [f.name, f]));
  return Object.entries(values).map(([name, value]) => {
    const f = fields.get(name);
    if (!f || f.readOnly) throw new Error(`field "${name}" is not writable`);
    return { f, value: bindValue(f, value) };
  });
}

export async function createRow(
  db: Database,
  entity: Entity,
  values: Record<string, unknown>,
  { onWrite }: WriteOptions = {},
): Promise<Row> {
  const set = assignments(entity, values);
  const insert =
    set.length === 0
      ? sql`default values`
      : sql`(${sql.join(set.map((s) => sql.id(s.f.name)))}) values (${sql.join(set.map((s) => s.value))})`;
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<Row>`
      insert into ${table(entity)} ${insert} ${returning(entity)}`.execute(trx);
    const row = rows[0]!;
    await onWrite?.(trx, { action: 'create', entity, before: null, after: row });
    return row;
  });
}

/** Lock the row a primary-key filter (from `decodeRecordId`) addresses. */
async function lockRow(trx: Database, entity: Entity, filter: Filter) {
  const { rows } = await sql<Row>`
    select ${selection(entity)} from ${entityRows(entity)}
    where ${compileFilter(filter, ALIAS)} limit 1 for update`.execute(trx);
  return rows[0];
}

/**
 * Update the row a primary-key filter addresses, provided it is still at `version`. The row is
 * locked first, so a concurrent update can't slip in between the check and the write.
 */
export async function updateRow(
  db: Database,
  entity: Entity,
  filter: Filter,
  values: Record<string, unknown>,
  { version, versionEntity = entity, onWrite }: WriteOptions & VersionCheck,
): Promise<WriteResult> {
  const set = assignments(entityFor(entity, 'update'), values);
  if (set.length === 0) throw new Error('nothing to update');
  return db.transaction().execute(async (trx): Promise<WriteResult> => {
    const before = await lockRow(trx, entity, filter);
    if (!before) return { ok: false, reason: 'notFound' };
    if (rowVersion(versionEntity, before) !== version) return { ok: false, reason: 'conflict' };
    const { rows } = await sql<Row>`
      update ${entityRows(entity)}
      set ${sql.join(set.map((s) => sql`${sql.id(s.f.name)} = ${s.value}`))}
      where ${compileFilter(filter, ALIAS)} ${returning(entity)}`.execute(trx);
    const row = rows[0]!;
    await onWrite?.(trx, { action: 'update', entity, before, after: row });
    return { ok: true, row };
  });
}

/**
 * Delete the row a primary-key filter addresses. With `version`, a row that has changed since is
 * a conflict. Returns the deleted row.
 */
export async function deleteRow(
  db: Database,
  entity: Entity,
  filter: Filter,
  { version, versionEntity = entity, onWrite }: WriteOptions & Partial<VersionCheck> = {},
): Promise<WriteResult> {
  return db.transaction().execute(async (trx): Promise<WriteResult> => {
    const before = await lockRow(trx, entity, filter);
    if (!before) return { ok: false, reason: 'notFound' };
    if (version !== undefined && rowVersion(versionEntity, before) !== version) {
      return { ok: false, reason: 'conflict' };
    }
    await sql`delete from ${entityRows(entity)} where ${compileFilter(filter, ALIAS)}`.execute(trx);
    await onWrite?.(trx, { action: 'delete', entity, before, after: null });
    return { ok: true, row: before };
  });
}
