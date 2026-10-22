import type { ViewState } from '@wardenhq/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';
import { useCurrentUser } from './auth';

// Shape served by apps/server/src/routes/saved-views.ts.
export interface SavedView {
  /** Numeric for saved views, `config:<key>` for views defined in config. */
  id: string;
  entity: string;
  name: string;
  origin: 'config' | 'shared' | 'personal';
  shared: boolean;
  mine: boolean;
  owner: string | null;
  canEdit: boolean;
  /** Null when the view uses a field the user can't see; it can only be replaced or deleted. */
  state: ViewState | null;
  updatedAt?: string;
  /** Config views: the key in config. */
  key?: string;
  sidebar?: true;
  default?: true;
  /** A view shared in the UI while shared views come only from config; others don't see it. */
  notInConfig?: true;
}

const VIEWS_URL = '/api/views';
const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The link that opens a saved view. It always shows the view's current state. */
export const viewPath = (view: Pick<SavedView, 'entity' | 'id'>) =>
  // Config ids keep their colon: `?view=config:fraud-review`.
  `/entities/${encodeURIComponent(view.entity)}?view=${encodeURIComponent(view.id).replace('%3A', ':')}`;

/**
 * URL param naming the config view the grid was opened from, so the views menu can tell when
 * the grid no longer matches it.
 */
export const FROM_PARAM = 'from';

/** Whether the current user administers views (exports every shared view). */
export function useIsViewsAdmin(): boolean {
  const { data: me } = useCurrentUser();
  return me?.admin?.includes('views') ?? false;
}

interface ViewList {
  views: SavedView[];
  /** False when the user lacks `admin: [views]`, or shared views come only from config. */
  canShare: boolean;
}

export function useViewList(entity: string) {
  return useQuery({
    queryKey: ['views', entity],
    queryFn: () => apiFetch<ViewList>(`${VIEWS_URL}?${new URLSearchParams({ entity })}`),
  });
}

/** Config views pinned to the sidebar, of every table. */
export function useSidebarViews() {
  return useQuery({
    queryKey: ['views', 'sidebar'],
    queryFn: async () => (await apiFetch<{ views: SavedView[] }>(`${VIEWS_URL}/sidebar`)).views,
  });
}

/** Every view shared in the UI, of every table; views admins only. */
export const fetchSharedViews = async () =>
  (await apiFetch<{ views: SavedView[] }>(`${VIEWS_URL}/shared`)).views;

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
