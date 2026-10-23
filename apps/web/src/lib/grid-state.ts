import { defaultSortOf, type Entity, type SortTerm, type ViewState } from '@wardenhq/core';

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;
/** Mirrors the server's MAX_OFFSET (apps/server/src/routes/entities.ts). */
export const MAX_OFFSET = 100_000;

/** A grid's sort, filter, search, columns, and page, as read from the URL. */
export interface GridState {
  /** Explicit sort, or the entity's default sort when the URL has none. */
  sort: SortTerm[];
  /** Raw JSON filter AST from the URL; the server validates it. */
  filter?: string;
  q: string;
  /** Visible columns, in the entity's field order; all of them when unset. */
  columns?: string[];
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Include soft-deleted rows; only ever set for entities that soft-delete. */
  showDeleted?: true;
}

export function parseSort(value: string | null): SortTerm[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({
      field: p.replace(/^[-+]/, ''),
      direction: p.startsWith('-') ? 'desc' : 'asc',
    }));
}

export const formatSort = (sort: SortTerm[]): string =>
  sort.map((t) => (t.direction === 'desc' ? `-${t.field}` : t.field)).join(',');

function positiveInt(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 ? n : undefined;
}

export function readGridState(params: URLSearchParams, entity: Entity): GridState {
  const sort = parseSort(params.get('sort'));
  const fallback = defaultSortOf(entity);
  const pageSize = positiveInt(params.get('pageSize'));
  const filter = params.get('filter');
  // Names the entity doesn't have (renamed or hidden since the link was made) are ignored.
  const listed = new Set(params.get('columns')?.split(',') ?? []);
  const columns = entity.fields.filter((f) => listed.has(f.name)).map((f) => f.name);
  return {
    sort: sort.length > 0 ? sort : fallback ? [fallback] : [],
    ...(filter ? { filter } : {}),
    q: params.get('q') ?? '',
    ...(columns.length > 0 && columns.length < entity.fields.length ? { columns } : {}),
    page: positiveInt(params.get('page')) ?? 1,
    pageSize: PAGE_SIZES.find((s) => s === pageSize) ?? DEFAULT_PAGE_SIZE,
    ...(entity.softDelete && params.get('deleted') === 'include' ? { showDeleted: true } : {}),
  };
}

export interface GridUpdate {
  sort?: SortTerm[];
  /** `null` clears it. */
  filter?: string | null;
  q?: string;
  /** `null` shows every column. */
  columns?: string[] | null;
  page?: number;
  pageSize?: number;
  showDeleted?: boolean;
}

/**
 * Apply an update to the URL params. Anything that changes which rows match or how many fit on
 * a page sends the user back to page 1. Defaults are left out to keep URLs short.
 */
export function writeGridState(params: URLSearchParams, update: GridUpdate): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | undefined) =>
    value ? next.set(key, value) : next.delete(key);

  if (update.sort) set('sort', formatSort(update.sort));
  if (update.filter !== undefined) set('filter', update.filter ?? undefined);
  if (update.q !== undefined) set('q', update.q.trim());
  if (update.columns !== undefined) set('columns', update.columns?.join(','));
  if (update.showDeleted !== undefined) set('deleted', update.showDeleted ? 'include' : undefined);
  if (update.pageSize !== undefined) {
    set('pageSize', update.pageSize === DEFAULT_PAGE_SIZE ? undefined : String(update.pageSize));
  }
  if (update.page !== undefined) {
    set('page', update.page > 1 ? String(update.page) : undefined);
  } else if (Object.keys(update).some((key) => key !== 'columns')) {
    // Showing or hiding columns doesn't change which rows are on the page.
    next.delete('page');
  }
  return next;
}

/** The parts of a grid's URL a saved view stores. */
const VIEW_PARAMS = ['sort', 'filter', 'q', 'columns'] as const;

/** URL params that show a saved view. Page and page size start over. */
export function viewParams(state: ViewState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.sort) params.set('sort', state.sort);
  if (state.filter) params.set('filter', JSON.stringify(state.filter));
  if (state.q) params.set('q', state.q);
  if (state.columns) params.set('columns', state.columns.join(','));
  return params;
}

/**
 * The view state of a grid's URL, for saving. The filter is parsed so the server can check it;
 * one that isn't valid JSON is left out (the grid is showing an error for it anyway).
 */
export function viewStateOf(params: URLSearchParams, entity: Entity): ViewState {
  const { columns } = readGridState(params, entity);
  const sort = params.get('sort')?.trim();
  const q = params.get('q')?.trim();
  let filter;
  try {
    filter = JSON.parse(params.get('filter') ?? 'null') ?? undefined;
  } catch {
    filter = undefined;
  }
  return {
    ...(filter !== undefined ? { filter } : {}),
    ...(q ? { q } : {}),
    ...(sort ? { sort } : {}),
    ...(columns ? { columns } : {}),
  };
}

/** Whether the grid's URL shows exactly this view (ignoring page and page size). */
export function showsView(params: URLSearchParams, entity: Entity, state: ViewState): boolean {
  // Round-trip both, so key order in the filter and column order don't matter.
  const normalize = (p: URLSearchParams) => {
    const { filter, ...rest } = viewStateOf(p, entity);
    const normalized = viewParams(rest);
    if (filter !== undefined) normalized.set('filter', canonicalJson(filter));
    return normalized;
  };
  const current = normalize(params);
  const view = normalize(viewParams(state));
  return VIEW_PARAMS.every((key) => current.get(key) === view.get(key));
}

/** JSON with object keys sorted, for comparing values that differ only in key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The list endpoint URL for a grid state. */
export function listUrl(entity: Entity, state: GridState): string {
  const params = new URLSearchParams();
  if (state.sort.length > 0) params.set('sort', formatSort(state.sort));
  if (state.filter) params.set('filter', state.filter);
  if (state.q.trim()) params.set('q', state.q.trim());
  params.set('limit', String(state.pageSize));
  const offset = (state.page - 1) * state.pageSize;
  if (offset > 0) params.set('offset', String(offset));
  params.set('count', 'true');
  if (state.showDeleted) params.set('deleted', 'include');
  return `/api/entities/${encodeURIComponent(entity.key)}?${params}`;
}

/** Highest page the server will serve at this page size, given its offset cap. */
export const maxPage = (pageSize: number) => Math.floor(MAX_OFFSET / pageSize) + 1;
