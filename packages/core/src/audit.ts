import type { Filter } from './filter.js';
import { parseSortFields } from './sort.js';

/** One field's change in an audit entry. A missing side (create, delete) is null. */
export interface FieldChange {
  from: unknown;
  to: unknown;
}

export type AuditDiff = Record<string, FieldChange>;

// Values are JSON-shaped (Postgres text for dates, strings for int8/numeric, and jsonb documents
// whose keys Postgres already orders), so comparing serializations is exact.
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The fields that differ between two versions of a row. On create every field of `after`
 * appears with `from: null`, and on delete every field of `before` with `to: null`.
 */
export function auditDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditDiff {
  const diff: AuditDiff = {};
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const field of fields) {
    const from = before ? (before[field] ?? null) : null;
    const to = after ? (after[field] ?? null) : null;
    if (!before || !after || !same(from, to)) diff[field] = { from, to };
  }
  return diff;
}

/** An audit log entry as the API returns it. */
export interface AuditEntry {
  /** Increasing; also the cursor for the next page. */
  id: string;
  /** ISO 8601 with offset. */
  occurredAt: string;
  requestId: string | null;
  /**
   * `roles` is left out of a record's History for readers without `admin: [audit]`. `userId` is
   * the internal user id config's `actor` mapped them to at sign-in, when it did.
   */
  actor: { subject: string; email: string | null; userId?: string; roles?: string[] };
  action: string;
  entity: string;
  recordId: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: AuditDiff;
  /** For entries that don't change a row (exports, custom actions, ...), what they did. */
  details: ExportDetails | RevokeSessionsDetails | ActionDetails | SoftDeleteDetails | null;
  /** The custom action this change was part of. */
  parent: { id: string; action: string } | null;
  /**
   * With an audit table that also holds the application's own entries (`audit.source`), who wrote
   * this one: Warden's tag value, the application's, or null.
   */
  source?: string | null;
}

/**
 * Set on a soft delete (a `delete` entry whose row is still there, with the soft-delete column
 * set) and on a restore (an `update` entry that clears it).
 */
export interface SoftDeleteDetails {
  softDelete: 'delete' | 'restore';
}

export const isSoftDeleteDetails = (
  details: AuditEntry['details'] | undefined,
): details is SoftDeleteDetails =>
  details != null &&
  'softDelete' in details &&
  (details.softDelete === 'delete' || details.softDelete === 'restore');

/**
 * A custom action's parent entry: what was asked for. Every row it changed has its own entry
 * pointing back at this one.
 */
export interface ActionDetails {
  /**
   * The input as sent, with record ids for picked records and sensitive fields redacted. Fields
   * that pick records of an entity the caller can't read are left out.
   */
  input: Record<string, unknown>;
  /** Ids of the records the action ran against. */
  records: string[];
  /** Set when input fields were left out because the caller can't read what they picked. */
  redacted?: true;
}

/** An action's details as the audit log stores them. */
export interface StoredActionDetails extends ActionDetails {
  /**
   * Input field → entity key, for the fields that pick records. Absent on entries written before
   * it was recorded.
   */
  refs?: Record<string, string>;
}

export const isActionDetails = (details: AuditEntry['details']): details is ActionDetails =>
  details !== null && 'input' in details;

/**
 * Entries about access rather than a table's rows, by the entity they're filed under: role
 * assignments (whose before and after are the assignment) and session revocations. Only the
 * audit log search shows them, to users with `admin: [audit]`.
 */
export const ACCESS_AUDIT_ACTIONS = {
  'warden.role_assignments': ['assign', 'unassign'],
  'warden.sessions': ['revoke_sessions'],
} as const satisfies Record<string, readonly string[]>;

/** What a `revoke_sessions` entry did: whose sessions it deleted, and how many. */
export interface RevokeSessionsDetails {
  /** OIDC subject of the user signed out. */
  subject: string;
  /** Their email, from the deleted sessions; absent on entries written before it was kept. */
  email?: string;
  sessions: number;
}

/** What an export included, recorded as the entry's details. */
export interface ExportDetails {
  /** Left out when the filter or search is, since it says how many rows matched them. */
  rowCount?: number;
  columns: string[];
  filter?: Filter;
  q?: string;
  /** The fields `q` was matched against. */
  searchFields?: string[];
  sort?: string;
  /** Soft-deleted rows were included, or the only ones exported; absent when left out. */
  deleted?: 'include' | 'only';
  /**
   * Set when the filter, search, or sort named a field the caller can't read now, so it was left
   * out. The entry still shows that the export happened.
   */
  redacted?: true;
}

const pick = <T>(values: Record<string, T>, fields: ReadonlySet<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(values).filter(([field]) => fields.has(field)));

/**
 * An entry cut down to `fields`, the ones the caller can read on its entity now. Entries record
 * every field exposed at the time, so fields since hidden, or restricted by role, are dropped
 * exactly as reads drop them. A custom action's input isn't made of the entity's fields; it loses
 * the fields that pick records of entities not in `entities`, the ones the caller can read.
 *
 * `written` is the fields an update set, as recorded with it; the rest of its diff is what the
 * database changed itself (defaults, triggers, generated columns). The reason is kept only when
 * the caller can read a field the update was asked to change. Entries from before `written` was
 * recorded (null) can't tell the two apart, so their reason is kept only when the caller can read
 * every changed field.
 */
export function projectAuditEntry(
  entry: AuditEntry,
  fields: readonly string[],
  written: readonly string[] | null = null,
  entities: ReadonlySet<string> = new Set(),
): AuditEntry {
  const visible = new Set(fields);
  return {
    ...entry,
    reason: entry.reason !== null && reasonVisible(entry, visible, written) ? entry.reason : null,
    before: entry.before && pick(entry.before, visible),
    after: entry.after && pick(entry.after, visible),
    diff: pick(entry.diff, visible),
    // Entities' entries have export, custom action, or soft delete details.
    details: isActionDetails(entry.details)
      ? projectActionDetails(entry.details, entities)
      : entry.details && 'columns' in entry.details
        ? projectDetails(entry.details, visible)
        : isSoftDeleteDetails(entry.details)
          ? { softDelete: entry.details.softDelete }
          : null,
  };
}

/**
 * Action details without the input fields that pick records of entities not in `entities`. Entries
 * from before the picked entities were recorded can't tell which fields those are, so they lose
 * their whole input.
 */
function projectActionDetails(
  details: StoredActionDetails,
  entities: ReadonlySet<string>,
): ActionDetails {
  const { input, records, refs } = details;
  const kept = refs
    ? Object.fromEntries(
        Object.entries(input).filter(
          ([field]) => !Object.hasOwn(refs, field) || entities.has(refs[field]!),
        ),
      )
    : {};
  const redacted = Object.keys(kept).length < Object.keys(input).length;
  return { input: kept, records, ...(redacted ? { redacted: true as const } : {}) };
}

// Creates and deletes change whether the row exists, which every reader of the entity can see.
function reasonVisible(
  { action, diff }: AuditEntry,
  visible: ReadonlySet<string>,
  written: readonly string[] | null,
): boolean {
  if (action !== 'update') return true;
  const changed = Object.keys(diff);
  if (written === null) return changed.every((f) => visible.has(f));
  return changed.some((f) => written.includes(f) && visible.has(f));
}

/**
 * Export details cut down to `visible` fields. A filter, search, or sort can't be cut down without
 * changing its meaning, so one that names any other field is left out entirely, and with a
 * filter or search the row count, which says how many rows matched it. A search recorded without
 * its fields is treated as naming some other field.
 */
function projectDetails(details: ExportDetails, visible: ReadonlySet<string>): ExportDetails {
  const { rowCount, filter, q, searchFields, sort, columns, ...rest } = details;
  const filterOk = filter === undefined || filterFields(filter).every((f) => visible.has(f));
  const searchOk = q === undefined || (searchFields?.every((f) => visible.has(f)) ?? false);
  const sortOk = sort === undefined || parseSortFields(sort).every((f) => visible.has(f));
  return {
    ...rest,
    ...(rowCount !== undefined && filterOk && searchOk ? { rowCount } : {}),
    columns: columns.filter((c) => visible.has(c)),
    ...(filter !== undefined && filterOk ? { filter } : {}),
    ...(q !== undefined && searchOk ? { q, ...(searchFields ? { searchFields } : {}) } : {}),
    ...(sort !== undefined && sortOk ? { sort } : {}),
    ...(!filterOk || !searchOk || !sortOk ? { redacted: true as const } : {}),
  };
}

/** Every field a filter names. */
export function filterFields(filter: Filter): string[] {
  if ('and' in filter) return filter.and.flatMap(filterFields);
  if ('or' in filter) return filter.or.flatMap(filterFields);
  if ('not' in filter) return filterFields(filter.not);
  return [filter.field];
}
