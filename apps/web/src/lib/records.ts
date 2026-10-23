import {
  checkFieldValue,
  relationFilter,
  type Entity,
  type Filter,
  type Relation,
} from '@wardenhq/core';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiFetch } from './api';
import { entityPath } from './schema';

export type Row = Record<string, unknown>;

export interface RecordItem {
  /** Opaque record id; null when the entity has no primary key. */
  id: string | null;
  /** Present when `id` is; an update must send it back (a stale one gets 409). */
  version?: string;
  values: Row;
}

export interface RecordList {
  items: RecordItem[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

/** Whether a row of an entity that soft-deletes is deleted, as the server decides it. */
export function isSoftDeleted(entity: Entity, row: Row): boolean {
  const softDelete = entity.softDelete;
  if (!softDelete) return false;
  const value = row[softDelete.column];
  return softDelete.kind === 'boolean' ? value === true : value !== null && value !== undefined;
}

export function recordPath(entity: Pick<Entity, 'key'>, id: string): string {
  return `${entityPath(entity)}/${encodeURIComponent(id)}`;
}

export function createRecordPath(entity: Pick<Entity, 'key'>): string {
  // The `-` segment keeps this apart from record ids: a record keyed "new" is `/entities/x/new`.
  return `${entityPath(entity)}/-/new`;
}

export function editRecordPath(entity: Pick<Entity, 'key'>, id: string): string {
  return `${recordPath(entity, id)}/edit`;
}

const recordsUrl = (entityKey: string) => `/api/entities/${encodeURIComponent(entityKey)}`;

export function useRecord(entity: Entity, id: string) {
  return useQuery({
    queryKey: ['record', entity.key, id],
    queryFn: () => apiFetch<RecordItem>(`${recordsUrl(entity.key)}/${encodeURIComponent(id)}`),
  });
}

/** Every cached query a write can change: lists, related records, and records. */
const isRecordQuery = (queryKey: readonly unknown[]) =>
  ['rows', 'children', 'parent', 'record', 'search'].includes(String(queryKey[0]));

/** What a write returns: the record, or only its id to callers who can't read the entity. */
export type WrittenRecord = Partial<RecordItem> & { id: string | null };

export interface CreateInput {
  values: Row;
  reason?: string;
}

export function useCreateRecord(entity: Entity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInput) =>
      apiFetch<WrittenRecord>(recordsUrl(entity.key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ predicate: ({ queryKey }) => isRecordQuery(queryKey) }),
  });
}

export interface UpdateInput {
  id: string;
  /** The version the edit started from; a stale one fails with 409. */
  version: string;
  values: Row;
  reason?: string;
}

/** Update the changed fields of a record. Changing its key changes its id. */
export function useUpdateRecord(entity: Entity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateInput) =>
      apiFetch<WrittenRecord>(`${recordsUrl(entity.key)}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ predicate: ({ queryKey }) => isRecordQuery(queryKey) }),
  });
}

/**
 * Delete a record, provided it is still at the version that was shown (a stale one fails with
 * 409). Lists and related records that might include it are refetched.
 */
export function useDeleteRecord(entity: Entity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reason, ...record }: RecordItem & { id: string; reason?: string }) =>
      apiFetch<void>(`${recordsUrl(entity.key)}/${encodeURIComponent(record.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(record.version ? { version: record.version } : {}),
          ...(reason ? { reason } : {}),
        }),
      }),
    onSuccess: (_, record) => {
      // Other tables' rows can change too (cascades, set null), so refetch every list. A
      // hard-deleted record itself is left alone: refetching it would only 404 while the page
      // leaves. A soft-deleted one is still there, now marked deleted.
      const deleted = JSON.stringify(['record', entity.key, record.id]);
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          isRecordQuery(queryKey) &&
          (entity.softDelete !== undefined || JSON.stringify(queryKey) !== deleted),
      });
    },
    // A conflict means the record changed (or another write raced); show its current state.
    onError: (_, record) =>
      queryClient.invalidateQueries({ queryKey: ['record', entity.key, record.id] }),
  });
}

/** Restore a soft-deleted record. Like an update, a stale version fails with 409. */
export function useRestoreRecord(entity: Entity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reason, ...record }: RecordItem & { id: string; reason?: string }) =>
      apiFetch<WrittenRecord>(
        `${recordsUrl(entity.key)}/${encodeURIComponent(record.id)}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(record.version ? { version: record.version } : {}),
            ...(reason ? { reason } : {}),
          }),
        },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ predicate: ({ queryKey }) => isRecordQuery(queryKey) }),
  });
}

/** The parent row a `belongsTo` relation points at, or null when the foreign key is null. */
export function useParentRecord(relation: Relation, row: Row) {
  const filter = relationFilter(relation, row);
  return useQuery({
    queryKey: ['parent', relation.entity, filter],
    enabled: filter !== null,
    queryFn: async () => {
      // The row still points at a soft-deleted parent, so link to it.
      const params = new URLSearchParams({
        filter: JSON.stringify(filter),
        limit: '1',
        deleted: 'include',
      });
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

export const SEARCH_PAGE_SIZE = 20;

/**
 * Records of `entity` matching what someone typed into a record picker: a search of its
 * searchable fields, or, when it has none, an exact match on its key. An empty term lists the
 * first page.
 */
export function useRecordSearch(
  entity: Entity,
  keyColumns: string[],
  term: string,
  enabled = true,
) {
  const q = term.trim();
  return useQuery({
    queryKey: ['search', entity.key, q],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(SEARCH_PAGE_SIZE) });
      if (q && entity.searchable.length > 0) {
        params.set('q', q);
      } else if (q) {
        const filter = keyFilter(entity, keyColumns, q);
        // Nothing can match a term that isn't a valid key.
        if (!filter) return { items: [], nextCursor: null, hasMore: false } satisfies RecordList;
        params.set('filter', JSON.stringify(filter));
      }
      return apiFetch<RecordList>(`${recordsUrl(entity.key)}?${params}`);
    },
  });
}

function keyFilter(entity: Entity, keyColumns: string[], term: string): Filter | null {
  const [column] = keyColumns;
  const field = entity.fields.find((f) => f.name === column);
  if (keyColumns.length !== 1 || !field || checkFieldValue(field, term)) return null;
  return { field: field.name, op: 'eq', value: term };
}
