import { z } from 'zod';
import type { Entity } from './effective-schema.js';
import { filterFields } from './audit.js';
import { filterSchema, validateFilter, type Filter, type FilterError } from './filter.js';
import { isFieldReadable, type Policy } from './policy.js';
import { parseSortFields, resolveSort } from './sort.js';

/** A grid's filter, search, sort, and visible columns, as a saved view stores them. */
export interface ViewState {
  filter?: Filter;
  /** Free-text search. */
  q?: string;
  /** As the list endpoint takes it: comma-separated fields, `-` prefix for descending. */
  sort?: string;
  /** Visible columns. Without it, every column is shown. */
  columns?: string[];
}

export const VIEW_LIMITS = { maxNameLength: 100, maxTextLength: 1000 } as const;

const viewStateSchema = z.strictObject({
  // Checked against the entity below, which is what reports the useful errors.
  filter: z.unknown().optional(),
  q: z.string().max(VIEW_LIMITS.maxTextLength).optional(),
  sort: z.string().max(VIEW_LIMITS.maxTextLength).optional(),
  columns: z.array(z.string().min(1).max(200)).min(1).max(1600).optional(),
});

export type ViewStateValidation =
  { ok: true; state: ViewState } | { ok: false; errors: FilterError[] };

/**
 * Check a view's state against an entity as the caller sees it. Like filters and sorts sent to
 * the list endpoint, it may only name fields the caller can see, so a view that names any other
 * field fails exactly as if that field didn't exist. Empty parts are dropped.
 */
export function validateViewState(entity: Entity, input: unknown): ViewStateValidation {
  const parsed = viewStateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const { filter, q, sort, columns } = parsed.data;
  const errors: FilterError[] = [];
  const state: ViewState = {};

  if (filter !== undefined) {
    const result = validateFilter(entity, filter);
    if (result.ok) state.filter = result.filter;
    else errors.push(...result.errors.map((e) => ({ ...e, path: joinPath('filter', e.path) })));
  }
  // Search ignores NUL (see searchFilter), and dropping it here keeps it out of the jsonb the
  // state is stored and audited in, which can't hold one.
  const search = q?.replaceAll('\0', '').trim();
  if (search) state.q = search;
  if (sort?.trim()) {
    const result = resolveSort(entity, sort);
    if (result.ok) state.sort = sort.trim();
    else errors.push({ path: 'sort', message: result.message });
  }
  if (columns) {
    const fields = new Set(entity.fields.map((f) => f.name));
    const seen = new Set<string>();
    columns.forEach((column, i) => {
      if (!fields.has(column)) {
        errors.push({ path: `columns.${i}`, message: `unknown field "${column}"` });
      } else if (seen.has(column)) {
        errors.push({ path: `columns.${i}`, message: `"${column}" appears more than once` });
      }
      seen.add(column);
    });
    state.columns = columns;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, state };
}

/**
 * Whether a stored view's state names a field that `roles` may not read because of `readableBy`.
 * Such a view must not exist for them at all: even its name may describe the field. A view that
 * is merely out of date (its field dropped or hidden for everyone) reveals nothing.
 */
export function namesRestrictedField(
  policy: Policy,
  roles: readonly string[],
  entity: string,
  state: unknown,
): boolean {
  const parsed = viewStateSchema.safeParse(state);
  // Stored states were valid when saved; if one can't be read, assume the worst.
  if (!parsed.success) return true;
  const { filter, sort, columns } = parsed.data;
  const fields = [...(columns ?? []), ...(sort ? parseSortFields(sort) : [])];
  if (filter !== undefined) {
    const result = filterSchema.safeParse(filter);
    if (!result.success) return true;
    fields.push(...filterFields(result.data));
  }
  return fields.some((field) => !isFieldReadable(policy, roles, entity, field));
}

const joinPath = (prefix: string, path: string) => (path ? `${prefix}.${path}` : prefix);

/** A view name as stored: trimmed, and undefined when empty or too long. */
export function viewName(input: string): string | undefined {
  const name = input.trim();
  return name && name.length <= VIEW_LIMITS.maxNameLength ? name : undefined;
}
