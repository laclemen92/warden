import type { Action } from '@wardenhq/core';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

// Shape served by apps/server/src/routes/capabilities.ts.
export interface Capabilities {
  entities: Record<string, { actions: Action[]; customActions?: string[] }>;
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: () => apiFetch<Capabilities>('/api/capabilities'),
    staleTime: Infinity,
  });
}

/**
 * Whether the current user may perform `action` on an entity. False until capabilities load
 * (or if they fail to), so controls appear only once they're known to work. The server enforces
 * the policy either way.
 */
export function useCan(entityKey: string, action: Action): boolean {
  const { data } = useCapabilities();
  // Own keys only, so an entity named "constructor" can't reach Object.prototype.
  const entity = data && Object.hasOwn(data.entities, entityKey) ? data.entities[entityKey] : null;
  return entity?.actions.includes(action) ?? false;
}
