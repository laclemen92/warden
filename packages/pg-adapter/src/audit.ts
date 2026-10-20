import { auditDiff, encodeRecordId } from '@wardenhq/core';
import { sql } from 'kysely';
import { WARDEN_SCHEMA } from './introspect.js';
import type { WriteHook } from './writes.js';

/** Who made a write and why, recorded with every audit entry. */
export interface AuditContext {
  actor: { subject: string; email?: string; roles: readonly string[] };
  /** Correlates the entry with the server's request logs. */
  requestId?: string;
  reason?: string;
}

/**
 * The audit insert failed, so the write was rolled back. A distinct type keeps a failure here
 * from being reported as a constraint error on the entity being written.
 */
export class AuditWriteError extends Error {
  constructor(cause: unknown) {
    super('could not write the audit log', { cause });
    this.name = 'AuditWriteError';
  }
}

const json = (value: unknown) => (value === null ? null : JSON.stringify(value));

/**
 * Write hook that appends an entry to `warden.audit_log` in the write's own transaction, so a
 * write and its entry commit or roll back together. Rows only hold exposed fields, so hidden
 * column values never reach the log.
 */
export function auditHook({ actor, requestId, reason }: AuditContext): WriteHook {
  return async (trx, { action, entity, before, after }) => {
    // The row as it now is; on delete, as it was. An update that changes the key is filed under
    // the new id.
    const row = (after ?? before)!;
    const primaryKey =
      entity.primaryKey.length > 0
        ? Object.fromEntries(entity.primaryKey.map((key) => [key, row[key] ?? null]))
        : null;
    try {
      await sql`
        insert into ${sql.id(WARDEN_SCHEMA, 'audit_log')}
          (request_id, actor_subject, actor_email, actor_roles, action, entity, record_id,
           primary_key, before, after, diff, reason)
        values (
          ${requestId ?? null}, ${actor.subject}, ${actor.email ?? null}, ${[...actor.roles]},
          ${action}, ${entity.key}, ${encodeRecordId(entity, row)},
          ${json(primaryKey)}::jsonb, ${json(before)}::jsonb, ${json(after)}::jsonb,
          ${json(auditDiff(before, after))}::jsonb, ${reason ?? null})`.execute(trx);
    } catch (err) {
      throw new AuditWriteError(err);
    }
  };
}
