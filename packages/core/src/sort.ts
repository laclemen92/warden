import type { Entity, Field } from './effective-schema.js';
import { fieldCategory, type FieldCategory } from './filter.js';

export interface SortTerm {
  field: string;
  direction: 'asc' | 'desc';
}

export const MAX_SORT_TERMS = 5;
const SORTABLE: ReadonlySet<FieldCategory> = new Set([
  'text',
  'number',
  'temporal',
  'boolean',
  'uuid',
  'enum',
]);

/** Whether rows can be ordered by this field. */
export const isSortable = (f: Field): boolean => SORTABLE.has(fieldCategory(f));

/** The field names in a sort string like `-created_at,email`, without checking them. */
export const parseSortFields = (input: string): string[] =>
  input
    .split(',')
    .map((p) => p.trim().replace(/^[-+]/, ''))
    .filter(Boolean);

const CREATION_COLUMNS = ['created_at', 'createdAt', 'inserted_at', 'insertedAt'];

/**
 * The sort a grid opens with when the request doesn't name one: the configured `defaultSort`, or
 * else newest first by a `created_at`-style column. Tables without a primary key get neither
 * heuristic, since there's no tie-breaker to make the order total.
 */
export function defaultSortOf(entity: Entity): SortTerm | undefined {
  if (entity.defaultSort) {
    return { field: entity.defaultSort.column, direction: entity.defaultSort.direction };
  }
  if (entity.primaryKey.length === 0) return undefined;
  for (const name of CREATION_COLUMNS) {
    const f = entity.fields.find((x) => x.name === name);
    if (f && !f.isArray && isSortable(f) && fieldCategory(f) === 'temporal') {
      return { field: name, direction: 'desc' };
    }
  }
  return undefined;
}

export type SortResolution = { ok: true; sort: SortTerm[] } | { ok: false; message: string };

/**
 * Resolve a sort string like `-created_at,email` (`-` for descending) against an entity, falling
 * back to `defaultSortOf`. Primary key columns are appended as tie-breakers so the
 * order is total, which keyset pagination relies on.
 */
export function resolveSort(entity: Entity, input?: string): SortResolution {
  const terms: SortTerm[] = [];

  if (input?.trim()) {
    const parts = input.split(',').map((p) => p.trim());
    if (parts.length > MAX_SORT_TERMS) {
      return { ok: false, message: `sort can have at most ${MAX_SORT_TERMS} fields` };
    }
    for (const part of parts) {
      const direction = part.startsWith('-') ? 'desc' : 'asc';
      const name = part.replace(/^[-+]/, '');
      const f = entity.fields.find((x) => x.name === name);
      if (!f) return { ok: false, message: `unknown field "${name}"` };
      if (!isSortable(f)) return { ok: false, message: `cannot sort by "${name}"` };
      if (terms.some((t) => t.field === name)) {
        return { ok: false, message: `"${name}" appears more than once in sort` };
      }
      terms.push({ field: name, direction });
    }
  } else {
    const fallback = defaultSortOf(entity);
    if (fallback) terms.push(fallback);
  }

  for (const key of entity.primaryKey) {
    if (!terms.some((t) => t.field === key)) terms.push({ field: key, direction: 'asc' });
  }
  return { ok: true, sort: terms };
}
