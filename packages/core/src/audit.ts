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
