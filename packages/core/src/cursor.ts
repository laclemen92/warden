import type { Entity } from './effective-schema.js';
import { fromBase64Url, toBase64Url } from './encoding.js';
import { checkFieldValue, type Scalar } from './filter.js';
import type { SortTerm } from './sort.js';

/** A keyset position: the sort values of the last row on the previous page. */
export type CursorValues = (Scalar | null)[];

const signature = (sort: SortTerm[]) =>
  sort.map((t) => `${t.direction === 'desc' ? '-' : ''}${t.field}`).join(',');

/** Encode the position after `row`. Bound to `sort` so a cursor can't be reused with another order. */
export function encodeCursor(sort: SortTerm[], row: Record<string, unknown>): string {
  const values = sort.map(({ field }) => {
    const v = row[field];
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      return v;
    throw new Error(`cannot encode ${typeof v} value of "${field}" in a cursor`);
  });
  return toBase64Url(JSON.stringify({ s: signature(sort), v: values }));
}

export type CursorDecoding = { ok: true; values: CursorValues } | { ok: false; message: string };

/** Decode a client-supplied cursor, validating every value against its field's type. */
export function decodeCursor(entity: Entity, sort: SortTerm[], cursor: string): CursorDecoding {
  const invalid = { ok: false, message: 'invalid cursor' } as const;
  const json = fromBase64Url(cursor);
  if (json === undefined) return invalid;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalid;
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid;
  const { s, v } = parsed as { s?: unknown; v?: unknown };
  if (s !== signature(sort))
    return { ok: false, message: 'cursor does not match the current sort' };
  if (!Array.isArray(v) || v.length !== sort.length) return invalid;

  for (const [i, term] of sort.entries()) {
    const value: unknown = v[i];
    if (value === null) continue;
    const f = entity.fields.find((x) => x.name === term.field);
    const scalar =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (!f || !scalar || checkFieldValue(f, value)) return invalid;
  }
  return { ok: true, values: v as CursorValues };
}
