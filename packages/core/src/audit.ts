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
  actor: { subject: string; email: string | null; roles: string[] };
  action: string;
  entity: string;
  recordId: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: AuditDiff;
  /** For actions that don't change a row, what they did. */
  details: ExportDetails | null;
}

/** What an export included, recorded as the entry's details. */
export interface ExportDetails {
  rowCount: number;
  columns: string[];
  filter?: Filter;
  q?: string;
  sort?: string;
  /**
   * Set when the filter or sort named a field the caller can't read now, so it was left out.
   * The entry still shows that the export happened.
   */
  redacted?: true;
}

const pick = <T>(values: Record<string, T>, fields: ReadonlySet<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(values).filter(([field]) => fields.has(field)));

/**
 * An entry cut down to `fields`, the ones the caller can read on its entity now. Entries record
 * every field exposed at the time, so fields since hidden, or restricted by role, are dropped
 * exactly as reads drop them.
 */
export function projectAuditEntry(entry: AuditEntry, fields: readonly string[]): AuditEntry {
  const visible = new Set(fields);
  return {
    ...entry,
    before: entry.before && pick(entry.before, visible),
    after: entry.after && pick(entry.after, visible),
    diff: pick(entry.diff, visible),
    details: entry.details && projectDetails(entry.details, visible),
  };
}

/**
 * Export details cut down to `visible` fields. A filter or sort can't be cut down without
 * changing its meaning, so one that names any other field is left out entirely.
 */
function projectDetails(details: ExportDetails, visible: ReadonlySet<string>): ExportDetails {
  const { filter, sort, columns, ...rest } = details;
  const filterOk = filter === undefined || filterFields(filter).every((f) => visible.has(f));
  const sortOk = sort === undefined || parseSortFields(sort).every((f) => visible.has(f));
  return {
    ...rest,
    columns: columns.filter((c) => visible.has(c)),
    ...(filter !== undefined && filterOk ? { filter } : {}),
    ...(sort !== undefined && sortOk ? { sort } : {}),
    ...(!filterOk || !sortOk ? { redacted: true as const } : {}),
  };
}

/** Every field a filter names. */
function filterFields(filter: Filter): string[] {
  if ('and' in filter) return filter.and.flatMap(filterFields);
  if ('or' in filter) return filter.or.flatMap(filterFields);
  if ('not' in filter) return filterFields(filter.not);
  return [filter.field];
}
