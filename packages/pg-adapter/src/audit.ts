import {
  auditDiff,
  encodeRecordId,
  projectAuditEntry,
  type AuditEntry,
  type Entity,
  type ExportDetails,
} from '@wardenhq/core';
import { sql, type Expression, type SqlBool } from 'kysely';
import type { Database } from './database.js';
import { escapeLike } from './filter.js';
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

/**
 * JSON text for a jsonb audit column. `json` columns can hold strings with NUL characters, which
 * jsonb rejects; failing the audit insert would leave such rows unwritable, so each NUL is
 * recorded as the six characters `\u0000` instead. In the JSON text, `\u0000` is a NUL escape
 * only after an even number of backslashes; after an odd number it is an escaped backslash
 * followed by the text `u0000`, which jsonb accepts as-is.
 */
const json = (value: unknown) =>
  value === null
    ? null
    : JSON.stringify(value).replace(/(?<!\\)((?:\\\\)*)\\u0000/g, '$1\\\\u0000');

/**
 * Write hook that appends an entry to `warden.audit_log` in the write's own transaction, so a
 * write and its entry commit or roll back together. Rows only hold exposed fields, so hidden
 * column values never reach the log.
 */
export function auditHook({ actor, requestId, reason }: AuditContext): WriteHook {
  return async (trx, { action, entity, before, after, written }) => {
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
           primary_key, before, after, diff, reason, written)
        values (
          ${requestId ?? null}, ${actor.subject}, ${actor.email ?? null}, ${[...actor.roles]},
          ${action}, ${entity.key}, ${encodeRecordId(entity, row)},
          ${json(primaryKey)}::jsonb, ${json(before)}::jsonb, ${json(after)}::jsonb,
          ${json(auditDiff(before, after))}::jsonb, ${reason ?? null},
          ${written ? [...written] : null}::text[])`.execute(trx);
    } catch (err) {
      throw new AuditWriteError(err);
    }
  };
}

/**
 * Record an export. It is written, and must commit, before any row is sent, so an export that
 * can't be audited never happens.
 */
export async function recordExport(
  db: Database,
  {
    actor,
    requestId,
    entity,
    details,
  }: Omit<AuditContext, 'reason'> & {
    entity: Entity;
    details: ExportDetails;
  },
): Promise<void> {
  try {
    await sql`
      insert into ${sql.id(WARDEN_SCHEMA, 'audit_log')}
        (request_id, actor_subject, actor_email, actor_roles, action, entity, details)
      values (${requestId ?? null}, ${actor.subject}, ${actor.email ?? null}, ${[...actor.roles]},
              'export', ${entity.key}, ${JSON.stringify(details)}::jsonb)`.execute(db);
  } catch (err) {
    throw new AuditWriteError(err);
  }
}

export interface AuditQuery {
  /**
   * Per entity key, the fields the caller can read. Only these entities' entries are returned,
   * cut down to these fields, and an update that wasn't asked to change any of these fields is
   * left out, so fields the caller can't see leave no trace. Fields the database changed itself
   * (such as an `updated_at` trigger) don't count.
   */
  visible: Record<string, readonly string[]>;
  entity?: string;
  recordId?: string;
  /** Case-insensitive substring of the actor's email or subject. */
  actor?: string;
  action?: string;
  /** Inclusive lower bound on `occurred_at`, as a timestamp Postgres accepts. */
  from?: string;
  /** Exclusive upper bound on `occurred_at`. */
  to?: string;
  /** Only entries older than this entry id (the previous page's last id). */
  before?: string;
  limit: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  hasMore: boolean;
}

interface AuditRow {
  id: string;
  occurred_at: string;
  request_id: string | null;
  actor_subject: string;
  actor_email: string | null;
  actor_roles: string[];
  action: string;
  entity: string;
  record_id: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: AuditEntry['diff'] | null;
  details: ExportDetails | null;
  written: string[] | null;
}

/** Audit entries matching `query`, newest first. */
export async function listAuditEntries(db: Database, query: AuditQuery): Promise<AuditPage> {
  const { visible, entity, recordId, actor, action, from, to, before, limit } = query;
  const fields = sql`${JSON.stringify(visible)}::jsonb`;
  const conditions: Expression<SqlBool>[] = [
    sql<SqlBool>`${fields} ? a.entity`,
    // The case keeps jsonb_object_keys away from diffs that aren't objects. An update counts only
    // the fields it set; entries from before those were recorded count every changed field.
    sql<SqlBool>`case
      when a.diff is null or jsonb_typeof(a.diff) <> 'object' or a.diff = '{}'::jsonb then true
      else exists (
        select from jsonb_object_keys(a.diff) as k (field)
        where (${fields} -> a.entity) ? k.field
          and (a.action <> 'update' or a.written is null or k.field = any (a.written)))
    end`,
  ];
  if (entity !== undefined) conditions.push(sql<SqlBool>`a.entity = ${entity}`);
  if (recordId !== undefined) conditions.push(sql<SqlBool>`a.record_id = ${recordId}`);
  if (actor !== undefined) {
    const pattern = `%${escapeLike(actor)}%`;
    conditions.push(
      sql<SqlBool>`(a.actor_email ilike ${pattern} or a.actor_subject ilike ${pattern})`,
    );
  }
  if (action !== undefined) conditions.push(sql<SqlBool>`a.action = ${action}`);
  if (from !== undefined) conditions.push(sql<SqlBool>`a.occurred_at >= ${from}::timestamptz`);
  if (to !== undefined) conditions.push(sql<SqlBool>`a.occurred_at < ${to}::timestamptz`);
  if (before !== undefined) conditions.push(sql<SqlBool>`a.id < ${before}::bigint`);

  const { rows } = await sql<AuditRow>`
    select a.id::text as id, to_json(a.occurred_at) #>> '{}' as occurred_at, a.request_id,
           a.actor_subject, a.actor_email, a.actor_roles, a.action, a.entity, a.record_id,
           a.reason, a.before, a.after, a.diff, a.details, a.written
    from ${sql.id(WARDEN_SCHEMA, 'audit_log')} as a
    where ${sql.join(conditions, sql` and `)}
    order by a.id desc
    limit ${limit + 1}`.execute(db);

  return {
    entries: rows.slice(0, limit).map((row) =>
      projectAuditEntry(
        {
          id: row.id,
          occurredAt: row.occurred_at,
          requestId: row.request_id,
          actor: { subject: row.actor_subject, email: row.actor_email, roles: row.actor_roles },
          action: row.action,
          entity: row.entity,
          recordId: row.record_id,
          reason: row.reason,
          before: row.before,
          after: row.after,
          diff: row.diff ?? {},
          details: row.details,
        },
        visible[row.entity] ?? [],
        row.written,
      ),
    ),
    hasMore: rows.length > limit,
  };
}
