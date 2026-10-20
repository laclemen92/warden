import type { SchemaModel } from '@wardenhq/core';
import { sql } from 'kysely';
import type { Database } from './database.js';
import { WARDEN_SCHEMA } from './introspect.js';

const SNAPSHOTS = sql.id(WARDEN_SCHEMA, 'schema_snapshots');
const AUDIT_LOG = sql.id(WARDEN_SCHEMA, 'audit_log');
// Serializes baseline changes across replicas; distinct from the migration lock.
const LOCK_ID = 0x736e6170; // "snap"

/** A stored copy of the introspected schema, used as the schema drift baseline. */
export interface SchemaSnapshot {
  /** int8, so a string like every other bigint Warden reads. */
  id: string;
  takenAt: string;
  /** OIDC subject of the admin who acknowledged it; null for the snapshot taken at first start. */
  takenBy: string | null;
  model: SchemaModel;
}

export interface SnapshotActor {
  subject: string;
  email?: string;
  roles: readonly string[];
  requestId?: string;
}

const COLUMNS = sql`id, taken_at as "takenAt", taken_by as "takenBy", model`;

export async function latestSchemaSnapshot(db: Database): Promise<SchemaSnapshot | undefined> {
  const { rows } = await sql<SchemaSnapshot>`
    select ${COLUMNS} from ${SNAPSHOTS} order by id desc limit 1`.execute(db);
  return rows[0];
}

/** The current baseline, recording `model` as the first one if there is none yet. */
export async function ensureSchemaSnapshot(
  db: Database,
  model: SchemaModel,
): Promise<SchemaSnapshot> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${LOCK_ID})`.execute(trx);
    const latest = await latestSchemaSnapshot(trx);
    if (latest) return latest;
    const { rows } = await sql<SchemaSnapshot>`
      insert into ${SNAPSHOTS} (model) values (${JSON.stringify(model)}::jsonb)
      returning ${COLUMNS}`.execute(trx);
    return rows[0]!;
  });
}

/**
 * Make `model` the new baseline and audit it, in one transaction. Returns `undefined` without
 * changing anything when the baseline is no longer `expectedId` (someone acknowledged first).
 */
export async function acknowledgeSchemaSnapshot(
  db: Database,
  {
    model,
    expectedId,
    actor,
    drift,
  }: { model: SchemaModel; expectedId: string; actor: SnapshotActor; drift: unknown },
): Promise<SchemaSnapshot | undefined> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${LOCK_ID})`.execute(trx);
    const latest = await latestSchemaSnapshot(trx);
    if (latest?.id !== expectedId) return undefined;

    const { rows } = await sql<SchemaSnapshot>`
      insert into ${SNAPSHOTS} (taken_by, model)
      values (${actor.subject}, ${JSON.stringify(model)}::jsonb)
      returning ${COLUMNS}`.execute(trx);
    const snapshot = rows[0]!;
    await sql`
      insert into ${AUDIT_LOG}
        (request_id, actor_subject, actor_email, actor_roles, action, entity, record_id,
         before, after, diff)
      values (${actor.requestId ?? null}, ${actor.subject}, ${actor.email ?? null},
              ${[...actor.roles]}, 'acknowledge', 'warden.schema_snapshots', ${snapshot.id},
              ${JSON.stringify({ baseline: latest.id })}::jsonb,
              ${JSON.stringify({ baseline: snapshot.id })}::jsonb,
              ${JSON.stringify(drift)}::jsonb)`.execute(trx);
    return snapshot;
  });
}
