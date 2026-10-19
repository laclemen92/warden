import type { EffectiveSchema, Entity } from '@wardenhq/core';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

export function useSchema() {
  return useQuery({
    queryKey: ['schema'],
    queryFn: () => apiFetch<EffectiveSchema>('/api/schema'),
    // The schema only changes when the server restarts.
    staleTime: Infinity,
  });
}

export function entityPath(entity: Pick<Entity, 'key'>): string {
  return `/entities/${encodeURIComponent(entity.key)}`;
}
