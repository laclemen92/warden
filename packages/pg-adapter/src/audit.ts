import {
  ACCESS_AUDIT_ACTIONS,
  WARDEN_AUDIT_COLUMNS,
  auditDiff,
  encodeRecordId,
  projectAuditEntry,
  type AuditEntry,
  type AuditField,
  type AuditStore,
  type Entity,
  type ExportDetails,
  type HttpActionOutcome,
  type RevokeSessionsDetails,
  type StoredActionDetails,
} from '@wardenhq/core';
import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely';
import type { Database } from './database.js';
import { escapeLike } from './filter.js';
import { WARDEN_SCHEMA } from './introspect.js';
import type { WriteHook } from './writes.js';

/** Who made a write and why, recorded with every audit entry. */
export interface AuditContext {
  /** `userId`: the internal user id config's `actor` mapped them to at sign-in. */
  actor: { subject: string; email?: string; userId?: string; roles: readonly string[] };
  /** Correlates the entry with the server's request logs. */
  requestId?: string;
  reason?: string;
  /** The custom action's entry this write is part of. */
  parentId?: string;
  /** Where the entry goes; `warden.audit_log` when absent. */
  store?: AuditStore;
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
 * The configured audit table doesn't match the database, so nothing that has to be audited may
 * happen, and there is no log to read. The message is safe to show: the details are logged at
 * startup.
 */
export class AuditUnavailableError extends Error {
  readonly statusCode = 503;
  constructor() {
    super(
      'the audit log is misconfigured: changes are disabled and the log is unreadable until it is fixed',
    );
    this.name = 'AuditUnavailableError';
  }
}

const WARDEN_STORE: AuditStore = { kind: 'warden' };

/** Whether entries written to `store` keep `field`. */
export const storesField = (store: AuditStore = WARDEN_STORE, field: AuditField) =>
  store.kind === 'warden' || (store.kind === 'table' && store.columns[field] !== undefined);

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

/** An entry's values by field. Warden sets `id` and `occurredAt` itself. */
export type AuditValues = { [F in Exclude<AuditField, 'id' | 'occurredAt'>]?: unknown };

const JSON_FIELDS: ReadonlySet<AuditField> = new Set([
  'primaryKey',
  'before',
  'after',
  'diff',
  'details',
]);

function storeTable(store: AuditStore): {
  table: RawBuilder<unknown>;
  columns: Partial<Record<AuditField, string>>;
  source?: { column: string; value: string };
} {
  switch (store.kind) {
    case 'warden':
      return { table: sql`${sql.id(WARDEN_SCHEMA, 'audit_log')}`, columns: WARDEN_AUDIT_COLUMNS };
    case 'table':
      return {
        table: sql`${sql.id(store.schema, store.name)}`,
        columns: store.columns,
        ...(store.source ? { source: store.source } : {}),
      };
    case 'unavailable':
      throw new AuditUnavailableError();
  }
}

/**
 * Insert an entry into `store` and return its id. Fields the store doesn't map are dropped.
 * Column names come from the store, which was checked against the database; values are always
 * bind parameters, typed by the column they go into.
 */
export async function insertAuditEntry(
  db: Database,
  store: AuditStore,
  values: AuditValues,
): Promise<string> {
  const { table, columns, source } = storeTable(store);
  const names: RawBuilder<unknown>[] = [];
  const exprs: RawBuilder<unknown>[] = [];
  const add = (column: string, value: RawBuilder<unknown>) => {
    names.push(sql.id(column));
    exprs.push(value);
  };
  // The write's transaction start, as `warden.audit_log`'s default.
  if (columns.occurredAt) add(columns.occurredAt, sql`now()`);
  for (const [field, value] of Object.entries(values) as [AuditField, unknown][]) {
    const column = columns[field];
    if (column === undefined || value === undefined) continue;
    add(column, sql`${JSON_FIELDS.has(field) ? json(value) : value}`);
  }
  if (source) add(source.column, sql`${source.value}`);
  const { rows } = await sql<{ id: string }>`
    insert into ${table} (${sql.join(names)}) values (${sql.join(exprs)})
    returning ${sql.id(columns.id!)}::text as id`.execute(db);
  return rows[0]!.id;
}

/** `insertAuditEntry` for writes: a failure is an `AuditWriteError`, a bad store isn't. */
async function writeEntry(db: Database, store: AuditStore, values: AuditValues) {
  if (store.kind === 'unavailable') throw new AuditUnavailableError();
  try {
    return await insertAuditEntry(db, store, values);
  } catch (err) {
    throw new AuditWriteError(err);
  }
}

const actorValues = (actor: AuditContext['actor'], requestId: string | undefined) => ({
  requestId: requestId ?? null,
  actorSubject: actor.subject,
  actorEmail: actor.email ?? null,
  actorUserId: actor.userId ?? null,
  actorRoles: [...actor.roles],
});

/**
 * Write hook that appends an entry to the audit store in the write's own transaction, so a
 * write and its entry commit or roll back together. Rows only hold exposed fields, so hidden
 * column values never reach the log.
 */
export function auditHook({
  actor,
  requestId,
  reason,
  parentId,
  store = WARDEN_STORE,
}: AuditContext): WriteHook {
  return async (trx, { action, entity, before, after, written, details }) => {
    // The row as it now is; on delete, as it was. An update that changes the key is filed under
    // the new id.
    const row = (after ?? before)!;
    const primaryKey =
      entity.primaryKey.length > 0
        ? Object.fromEntries(entity.primaryKey.map((key) => [key, row[key] ?? null]))
        : null;
    await writeEntry(trx, store, {
      ...actorValues(actor, requestId),
      action,
      entity: entity.key,
      recordId: encodeRecordId(entity, row),
      primaryKey,
      before,
      after,
      diff: auditDiff(before, after),
      reason: reason ?? null,
      written: written ? [...written] : null,
      ...(details ? { details } : {}),
      parentId: parentId ?? null,
    });
  };
}

/**
 * Insert a custom action's parent entry inside its transaction and return its id, which every
 * row the action changes points back at. It commits or rolls back with them. It is written
 * before the action runs (children need its id, and the log is append-only), so it records what
 * was asked for rather than the outcome.
 */
export async function insertActionEntry(
  trx: Database,
  {
    actor,
    requestId,
    reason,
    action,
    entity,
    record,
    details,
    store = WARDEN_STORE,
  }: Omit<AuditContext, 'parentId'> & {
    /** The action's name. */
    action: string;
    entity: Entity;
    /** The target row, for `target: 'one'`. */
    record?: Record<string, unknown>;
    details: StoredActionDetails;
  },
): Promise<string> {
  const primaryKey =
    record && entity.primaryKey.length > 0
      ? Object.fromEntries(entity.primaryKey.map((key) => [key, record[key] ?? null]))
      : null;
  return writeEntry(trx, store, {
    ...actorValues(actor, requestId),
    action,
    entity: entity.key,
    recordId: record ? encodeRecordId(entity, record) : null,
    primaryKey,
    details,
    reason: reason ?? null,
  });
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
    store = WARDEN_STORE,
  }: Omit<AuditContext, 'reason'> & {
    entity: Entity;
    details: ExportDetails;
  },
): Promise<void> {
  await writeEntry(db, store, {
    ...actorValues(actor, requestId),
    action: 'export',
    entity: entity.key,
    details,
  });
}

export interface AuditQuery {
  /**
   * Per entity key, the fields the caller can read. Only these entities' entries are returned,
   * cut down to these fields, and an update that wasn't asked to change any of these fields is
   * left out, so fields the caller can't see leave no trace. Fields the database changed itself
   * (such as an `updated_at` trigger) don't count. Custom action inputs that pick records of
   * entities not listed here are cut too.
   */
  visible: Record<string, readonly string[]>;
  /**
   * Custom actions whose own entries (what was asked for: the input and reason) are returned, by
   * name. Other actions' entries are left out, and the rows they changed lose their link to them,
   * so the action's name doesn't show either. Omit for every action.
   */
  actions?: readonly string[];
  /**
   * Also return role assignment and session revocation entries (`ACCESS_AUDIT_ACTIONS`), in
   * full. Only for callers with `admin: [audit]`.
   */
  includeAccessEntries?: boolean;
  entity?: string;
  recordId?: string;
  /** Case-insensitive substring of the actor's email or subject, or their exact user id. */
  actor?: string;
  action?: string;
  /** Inclusive lower bound on `occurred_at`, as a timestamp Postgres accepts. */
  from?: string;
  /** Exclusive upper bound on `occurred_at`. */
  to?: string;
  /** Only the rows changed by the custom action with this parent entry id. */
  parentId?: string;
  /** Only entries older than this entry id (the previous page's last id). */
  before?: string;
  /** Only entries tagged with this source value; needs a store with `source`. */
  source?: string;
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
  actor_user_id: string | null;
  actor_roles: string[] | null;
  action: string;
  entity: string;
  record_id: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: AuditEntry['diff'] | null;
  details: ExportDetails | StoredActionDetails | { sessions: number; email?: string } | null;
  primary_key: Record<string, unknown> | null;
  written: string[] | null;
  parent_id: string | null;
  parent_action: string | null;
  source?: string | null;
}

const accessEntry = sql<SqlBool>`(a.entity, a.action) in (${sql.join(
  Object.entries(ACCESS_AUDIT_ACTIONS).flatMap(([entity, actions]) =>
    actions.map((action) => sql`(${entity}, ${action})`),
  ),
)})`;

/**
 * A `revoke_sessions` entry keeps the user's subject as its primary key, or in its details in a
 * store without one.
 */
const revokeDetails = (row: AuditRow): RevokeSessionsDetails => {
  const details = row.details as { sessions: number; email?: string; subject?: string };
  return { ...details, subject: String(row.primary_key?.subject ?? details.subject ?? '') };
};

/**
 * The store's entries as `warden.audit_log` columns. A configured table's columns are cast to the
 * types Warden reads, unmapped fields are null, and JSON that isn't an object (which only the
 * application could have written) is read as null, so its rows read like Warden's.
 */
function auditRelation(store: AuditStore): RawBuilder<unknown> {
  if (store.kind === 'unavailable') throw new AuditUnavailableError();
  if (store.kind === 'warden') return sql`${sql.id(WARDEN_SCHEMA, 'audit_log')}`;
  const column = (field: AuditField) => {
    const name = store.columns[field];
    return name === undefined ? undefined : sql.id('t', name);
  };
  const as = (field: AuditField, type: 'text' | 'text[]' | 'bigint', alias: string) => {
    const c = column(field);
    return c
      ? sql`${c}::${sql.raw(type)} as ${sql.id(alias)}`
      : sql`null::${sql.raw(type)} as ${sql.id(alias)}`;
  };
  const object = (field: AuditField, alias: string) => {
    const c = column(field);
    return c
      ? sql`case when jsonb_typeof(${c}::jsonb) = 'object' then ${c}::jsonb end as ${sql.id(alias)}`
      : sql`null::jsonb as ${sql.id(alias)}`;
  };
  const source = store.source ? sql`${sql.id('t', store.source.column)}::text` : sql`null::text`;
  return sql`(select
    ${column('id')} as id,
    -- A timestamp without time zone holds now() in the session time zone; read it back with an offset.
    ${column('occurredAt')}::timestamptz as occurred_at,
    ${as('requestId', 'text', 'request_id')}, ${as('actorSubject', 'text', 'actor_subject')},
    ${as('actorEmail', 'text', 'actor_email')}, ${as('actorUserId', 'text', 'actor_user_id')},
    ${as('actorRoles', 'text[]', 'actor_roles')},
    ${as('action', 'text', 'action')}, ${as('entity', 'text', 'entity')},
    ${as('recordId', 'text', 'record_id')}, ${as('reason', 'text', 'reason')},
    ${object('primaryKey', 'primary_key')}, ${object('before', 'before')},
    ${object('after', 'after')}, ${object('diff', 'diff')}, ${object('details', 'details')},
    ${as('written', 'text[]', 'written')}, ${as('parentId', 'bigint', 'parent_id')},
    ${source} as source
    from ${sql.id(store.schema, store.name)} as t)`;
}

/** Audit entries matching `query`, newest first. */
export async function listAuditEntries(
  db: Database,
  query: AuditQuery,
  store: AuditStore = WARDEN_STORE,
): Promise<AuditPage> {
  const { visible, actions, includeAccessEntries, entity, recordId, actor, action } = query;
  const { from, to, parentId, before, source, limit } = query;
  const relation = auditRelation(store);
  const withSource = store.kind === 'table' && store.source !== undefined;
  const fields = sql`${JSON.stringify(visible)}::jsonb`;
  const readable = new Set(Object.keys(visible));
  const entityEntry = sql<SqlBool>`(${fields} ? a.entity and
    -- The case keeps jsonb_object_keys away from diffs that aren't objects. An update counts only
    -- the fields it set; entries from before those were recorded count every changed field.
    case
      when a.diff is null or jsonb_typeof(a.diff) <> 'object' or a.diff = '{}'::jsonb then true
      else exists (
        select from jsonb_object_keys(a.diff) as k (field)
        where (${fields} -> a.entity) ? k.field
          and (a.action <> 'update' or a.written is null or k.field = any (a.written)))
    end)`;
  const conditions: Expression<SqlBool>[] = [
    includeAccessEntries ? sql<SqlBool>`(${entityEntry} or ${accessEntry})` : entityEntry,
  ];
  if (actions !== undefined) {
    // An action's own entry is the one without a parent that has input.
    conditions.push(sql<SqlBool>`(a.parent_id is not null
      or not coalesce(a.details ? 'input', false)
      or a.action = any (${[...actions]}::text[]))`);
  }
  if (entity !== undefined) conditions.push(sql<SqlBool>`a.entity = ${entity}`);
  if (recordId !== undefined) conditions.push(sql<SqlBool>`a.record_id = ${recordId}`);
  if (actor !== undefined) {
    const pattern = `%${escapeLike(actor)}%`;
    conditions.push(
      sql<SqlBool>`(a.actor_email ilike ${pattern} or a.actor_subject ilike ${pattern}
        or a.actor_user_id = ${actor})`,
    );
  }
  if (action !== undefined) conditions.push(sql<SqlBool>`a.action = ${action}`);
  if (from !== undefined) conditions.push(sql<SqlBool>`a.occurred_at >= ${from}::timestamptz`);
  if (to !== undefined) conditions.push(sql<SqlBool>`a.occurred_at < ${to}::timestamptz`);
  if (parentId !== undefined) conditions.push(sql<SqlBool>`a.parent_id = ${parentId}::bigint`);
  if (before !== undefined) conditions.push(sql<SqlBool>`a.id < ${before}::bigint`);
  if (source !== undefined) {
    conditions.push(withSource ? sql<SqlBool>`a.source = ${source}` : sql<SqlBool>`false`);
  }

  const { rows } = await sql<AuditRow>`
    select a.id::text as id, to_json(a.occurred_at) #>> '{}' as occurred_at, a.request_id,
           a.actor_subject, a.actor_email, a.actor_user_id, a.actor_roles, a.action, a.entity, a.record_id,
           a.reason, a.before, a.after, a.diff, a.details, a.primary_key, a.written,
           a.parent_id::text as parent_id, p.action as parent_action
           ${withSource ? sql`, a.source` : sql``}
    from ${relation} as a
    left join ${relation} as p on p.id = a.parent_id
    where ${sql.join(conditions, sql` and `)}
    order by a.id desc
    limit ${limit + 1}`.execute(db);

  return {
    entries: rows.slice(0, limit).map((row) => {
      const entry: AuditEntry = {
        id: row.id,
        occurredAt: row.occurred_at,
        requestId: row.request_id,
        actor: {
          subject: row.actor_subject,
          email: row.actor_email,
          ...(row.actor_user_id !== null ? { userId: row.actor_user_id } : {}),
          // Unknown, rather than none, in a store that doesn't keep them.
          ...(row.actor_roles !== null ? { roles: row.actor_roles } : {}),
        },
        action: row.action,
        entity: row.entity,
        recordId: row.record_id,
        reason: row.reason,
        before: row.before,
        after: row.after,
        diff: row.diff ?? {},
        details: row.details as ExportDetails | StoredActionDetails | null,
        parent:
          row.parent_id !== null &&
          (actions === undefined || actions.includes(row.parent_action ?? ''))
            ? { id: row.parent_id, action: row.parent_action ?? '' }
            : null,
        ...(withSource ? { source: row.source ?? null } : {}),
      };
      // An entity's entry, or (only when asked for) an access entry, which is shown in full.
      if (Object.hasOwn(visible, row.entity)) {
        return projectAuditEntry(entry, visible[row.entity]!, row.written, readable);
      }
      return row.action === 'revoke_sessions' ? { ...entry, details: revokeDetails(row) } : entry;
    }),
    hasMore: rows.length > limit,
  };
}

/** An HTTP action's own entry, and the outcome entries written for it since. */
export interface ActionAttempt {
  id: string;
  actorSubject: string;
  reason: string | null;
  recordId: string | null;
  /** Null in a store that doesn't keep details. */
  details: StoredActionDetails | null;
  /** How long ago it was written. */
  ageMs: number;
  /** Its outcome entries' `details.outcome`, oldest first. */
  outcomes: HttpActionOutcome[];
}

/**
 * The entry action `action` wrote as attempt `id` (not an outcome or a retry's entry), with its
 * outcomes. Undefined when there is no such entry.
 */
export async function loadActionAttempt(
  db: Database,
  { id, action }: { id: string; action: string },
  store: AuditStore = WARDEN_STORE,
): Promise<ActionAttempt | undefined> {
  const relation = auditRelation(store);
  const { rows } = await sql<{
    id: string;
    actor_subject: string;
    reason: string | null;
    record_id: string | null;
    details: StoredActionDetails | null;
    age_ms: number;
  }>`
    select a.id::text as id, a.actor_subject, a.reason, a.record_id, a.details,
           (extract(epoch from (now() - a.occurred_at)) * 1000)::float8 as age_ms
    from ${relation} as a
    where a.id = ${id}::bigint and a.action = ${action} and a.parent_id is null
      and coalesce(a.details ? 'input', false)
      and not (a.details ? 'outcome') and not (a.details ? 'retryOf')`.execute(db);
  const row = rows[0];
  if (!row) return undefined;
  // Outcomes are written after their attempt, so the scan starts at its id.
  const { rows: outcomes } = await sql<{ outcome: HttpActionOutcome }>`
    select a.details -> 'outcome' as outcome
    from ${relation} as a
    where a.id > ${id}::bigint and a.action = ${action}
      and a.details -> 'outcome' ->> 'attempt' = ${id}
    order by a.id`.execute(db);
  return {
    id: row.id,
    actorSubject: row.actor_subject,
    reason: row.reason,
    recordId: row.record_id,
    details: row.details,
    ageMs: Number(row.age_ms),
    outcomes: outcomes.map((o) => o.outcome),
  };
}

/** What the connected role may do to a configured audit table. */
export interface AuditTableAccess {
  /** It can insert entries (into at least some columns; an insert that fails is rolled back). */
  insert: boolean;
  select: boolean;
  /**
   * It could change or remove entries: it may update, delete, or truncate, or it owns the table
   * (directly or through a role it belongs to), or is a superuser.
   */
  tamper: boolean;
}

/** The connected role's access to `table`; undefined when the table doesn't exist. */
export async function auditTableAccess(
  db: Database,
  table: { schema: string; name: string },
): Promise<AuditTableAccess | undefined> {
  const { rows } = await sql<AuditTableAccess>`
    select has_any_column_privilege(c.oid, 'INSERT') as insert,
           has_any_column_privilege(c.oid, 'SELECT') as select,
           r.rolsuper
             or pg_has_role(current_user, c.relowner, 'MEMBER')
             or has_any_column_privilege(c.oid, 'UPDATE')
             or has_table_privilege(c.oid, 'DELETE')
             or has_table_privilege(c.oid, 'TRUNCATE') as tamper
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.rolname = current_user
    where n.nspname = ${table.schema} and c.relname = ${table.name}`.execute(db);
  return rows[0];
}
