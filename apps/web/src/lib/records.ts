import { relationFilter, type Entity, type Relation } from '@wardenhq/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';
import { entityPath } from './schema';

export type Row = Record<string, unknown>;

export interface RecordItem {
  /** Opaque record id; null when the entity has no primary key. */
  id: string | null;
  values: Row;
}

export interface RecordList {
  items: RecordItem[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export function recordPath(entity: Pick<Entity, 'key'>, id: string): string {
  return `${entityPath(entity)}/${encodeURIComponent(id)}`;
}

const recordsUrl = (entityKey: string) => `/api/entities/${encodeURIComponent(entityKey)}`;

export function useRecord(entity: Entity, id: string) {
  return useQuery({
    queryKey: ['record', entity.key, id],
    queryFn: () => apiFetch<RecordItem>(`${recordsUrl(entity.key)}/${encodeURIComponent(id)}`),
  });
}

/** The parent row a `belongsTo` relation points at, or null when the foreign key is null. */
export function useParentRecord(relation: Relation, row: Row) {
  const filter = relationFilter(relation, row);
  return useQuery({
    queryKey: ['parent', relation.entity, filter],
    enabled: filter !== null,
    queryFn: async () => {
      const params = new URLSearchParams({ filter: JSON.stringify(filter), limit: '1' });
      const list = await apiFetch<RecordList>(`${recordsUrl(relation.entity)}?${params}`);
      return list.items[0] ?? null;
    },
  });
}

export const CHILD_PAGE_SIZE = 20;

/** Rows of a `hasMany` relation that reference `row`, a page at a time. */
export function useChildRecords(relation: Relation, row: Row) {
  const filter = relationFilter(relation, row);
  return useInfiniteQuery({
    queryKey: ['children', relation.entity, filter],
    enabled: filter !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        filter: JSON.stringify(filter),
        limit: String(CHILD_PAGE_SIZE),
      });
      if (pageParam) params.set('cursor', pageParam);
      else params.set('count', 'true');
      return apiFetch<RecordList>(`${recordsUrl(relation.entity)}?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}
