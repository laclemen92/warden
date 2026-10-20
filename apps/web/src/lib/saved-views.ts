import type { ViewState } from '@wardenhq/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';
import { useCurrentUser } from './auth';

// Shape served by apps/server/src/routes/saved-views.ts.
export interface SavedView {
  id: string;
  entity: string;
  name: string;
  shared: boolean;
  mine: boolean;
  owner: string | null;
  canEdit: boolean;
  /** Null when the view uses a field the user can't see; it can only be replaced or deleted. */
  state: ViewState | null;
  updatedAt: string;
}

const VIEWS_URL = '/api/views';
const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The link that opens a saved view. It always shows the view's current state. */
export const viewPath = (view: Pick<SavedView, 'entity' | 'id'>) =>
  `/entities/${encodeURIComponent(view.entity)}?view=${encodeURIComponent(view.id)}`;

/** Whether the current user may share views. The server enforces it either way. */
export function useCanShareViews(): boolean {
  const { data: me } = useCurrentUser();
  return me?.admin?.includes('views') ?? false;
}

export function useSavedViews(entity: string) {
  return useQuery({
    queryKey: ['views', entity],
    queryFn: async () =>
      (await apiFetch<{ views: SavedView[] }>(`${VIEWS_URL}?${new URLSearchParams({ entity })}`))
        .views,
  });
}

/** One view, for opening a view link. */
export function useSavedView(id: string | null) {
  return useQuery({
    queryKey: ['view', id],
    queryFn: () => apiFetch<SavedView>(`${VIEWS_URL}/${encodeURIComponent(id!)}`),
    enabled: id !== null,
    retry: false,
  });
}

export interface ViewChanges {
  name?: string;
  shared?: boolean;
  state?: ViewState;
}

export function useSavedViewMutations(entity: string) {
  const queryClient = useQueryClient();
  const onSettled = () => queryClient.invalidateQueries({ queryKey: ['views', entity] });
  return {
    create: useMutation({
      mutationFn: (view: { name: string; shared: boolean; state: ViewState }) =>
        apiFetch<SavedView>(VIEWS_URL, { method: 'POST', ...json({ entity, ...view }) }),
      onSettled,
    }),
    update: useMutation({
      mutationFn: ({ id, changes }: { id: string; changes: ViewChanges }) =>
        apiFetch<SavedView>(`${VIEWS_URL}/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          ...json(changes),
        }),
      onSettled,
    }),
    remove: useMutation({
      mutationFn: (id: string) =>
        apiFetch<void>(`${VIEWS_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      onSettled,
    }),
  };
}
