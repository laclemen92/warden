import type { AuditEntry, Entity } from '@wardenhq/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiFetch } from './api';
import { useCurrentUser } from './auth';

export type { AuditEntry };

export const AUDIT_LOG_PATH = '/admin/audit';
export const AUDIT_PAGE_SIZE = 25;

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

/** Whether the current user may open the audit log page. The server enforces it either way. */
export function useCanViewAuditLog(): boolean {
  const { data: me } = useCurrentUser();
  return me?.admin?.includes('audit') ?? false;
}

/** A record's audit entries, newest first, a page at a time. */
export function useRecordHistory(entity: Entity, id: string) {
  return useInfiniteQuery({
    queryKey: ['history', entity.key, id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
      if (pageParam) params.set('cursor', pageParam);
      const url = `/api/entities/${encodeURIComponent(entity.key)}/${encodeURIComponent(id)}/history`;
      return apiFetch<AuditPage>(`${url}?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Audit log search filters, as kept in the page URL. Dates are local `YYYY-MM-DD` days. */
export interface AuditFilters {
  actor?: string;
  entity?: string;
  action?: string;
  from?: string;
  to?: string;
  /** A custom action's entry id: only the rows it changed. */
  parent?: string;
}

const FILTER_KEYS = ['actor', 'entity', 'action', 'from', 'to', 'parent'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function filtersFromParams(params: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key)?.trim();
    if (!value) continue;
    // A hand-edited URL with a bad date is ignored rather than sent.
    if ((key === 'from' || key === 'to') && !DAY.test(value)) continue;
    filters[key] = value;
  }
  return filters;
}

export function filtersToParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
  }
  return params;
}

/** Start of a local day as an ISO timestamp, `days` after `day`. */
function startOfDay(day: string, days = 0): string | undefined {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y!, m! - 1, d! + days);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The API query for `filters`. The `to` day is inclusive, so it ends at the next midnight. */
export function auditSearchParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.entity) params.set('entity', filters.entity);
  if (filters.action) params.set('action', filters.action);
  if (filters.parent) params.set('parent', filters.parent);
  const from = filters.from && startOfDay(filters.from);
  const to = filters.to && startOfDay(filters.to, 1);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params;
}

export function useAuditSearch(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = auditSearchParams(filters);
      params.set('limit', String(AUDIT_PAGE_SIZE));
      if (pageParam) params.set('cursor', pageParam);
      return apiFetch<AuditPage>(`/api/audit?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}
