import type { AuditStore, SchemaModel } from '@wardenhq/core';
import { sql } from 'kysely';
import { insertAuditEntry } from './audit.js';
import type { Database } from './database.js';
import { WARDEN_SCHEMA } from './introspect.js';

const SNAPSHOTS = sql.id(WARDEN_SCHEMA, 'schema_snapshots');
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
  /** The internal user id config's `actor` mapped them to at sign-in. */
  userId?: string;
  roles: readonly string[];
  requestId?: string;
  /** Where the acknowledgement is audited; `warden.audit_log` when absent. */
  store?: AuditStore;
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
    await insertAuditEntry(trx, actor.store ?? { kind: 'warden' }, {
      requestId: actor.requestId ?? null,
      actorSubject: actor.subject,
      actorEmail: actor.email ?? null,
      actorUserId: actor.userId ?? null,
      actorRoles: [...actor.roles],
      action: 'acknowledge',
      entity: 'warden.schema_snapshots',
      recordId: snapshot.id,
      before: { baseline: latest.id },
      after: { baseline: snapshot.id },
      diff: drift,
    });
    return snapshot;
  });
}
