import type { Entity, SortTerm } from '@wardenhq/core';

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;
/** Mirrors the server's MAX_OFFSET (apps/server/src/routes/entities.ts). */
export const MAX_OFFSET = 100_000;

/** A grid's sort, filter, search, and page, as read from the URL. */
export interface GridState {
  /** Explicit sort, or the entity's default sort when the URL has none. */
  sort: SortTerm[];
  /** Raw JSON filter AST from the URL; the server validates it. */
  filter?: string;
  q: string;
  /** 1-based. */
  page: number;
  pageSize: number;
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
  const pageSize = positiveInt(params.get('pageSize'));
  const filter = params.get('filter');
  return {
    sort:
      sort.length > 0
        ? sort
        : entity.defaultSort
          ? [{ field: entity.defaultSort.column, direction: entity.defaultSort.direction }]
          : [],
    ...(filter ? { filter } : {}),
    q: params.get('q') ?? '',
    page: positiveInt(params.get('page')) ?? 1,
    pageSize: PAGE_SIZES.find((s) => s === pageSize) ?? DEFAULT_PAGE_SIZE,
  };
}

export interface GridUpdate {
  sort?: SortTerm[];
  /** `null` clears it. */
  filter?: string | null;
  q?: string;
  page?: number;
  pageSize?: number;
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
  if (update.pageSize !== undefined) {
    set('pageSize', update.pageSize === DEFAULT_PAGE_SIZE ? undefined : String(update.pageSize));
  }
  if (update.page !== undefined) {
    set('page', update.page > 1 ? String(update.page) : undefined);
  } else {
    next.delete('page');
  }
  return next;
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
  return `/api/entities/${encodeURIComponent(entity.key)}?${params}`;
}

/** Highest page the server will serve at this page size, given its offset cap. */
export const maxPage = (pageSize: number) => Math.floor(MAX_OFFSET / pageSize) + 1;
