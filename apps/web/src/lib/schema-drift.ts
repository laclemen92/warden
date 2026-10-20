import type { SchemaDrift } from '@wardenhq/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';
import { useCurrentUser } from './auth';

export const SCHEMA_DRIFT_PATH = '/admin/schema-drift';
const DRIFT_URL = '/api/admin/schema-drift';

export interface SchemaDriftReport {
  baseline: { id: string; takenAt: string; takenBy: string | null };
  drift: SchemaDrift;
}

/** Whether the current user may open the schema drift page. The server enforces it either way. */
export function useCanViewSchemaDrift(): boolean {
  const { data: me } = useCurrentUser();
  return me?.admin?.includes('schema') ?? false;
}

export function useSchemaDrift() {
  return useQuery({
    queryKey: ['schema-drift'],
    queryFn: () => apiFetch<SchemaDriftReport>(DRIFT_URL),
  });
}

export function useAcknowledgeDrift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (baselineId: string) =>
      apiFetch<SchemaDriftReport>(`${DRIFT_URL}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baselineId }),
      }),
    onSuccess: (report) => queryClient.setQueryData(['schema-drift'], report),
    // On a conflict someone else acknowledged first; show their baseline.
    onError: () => queryClient.invalidateQueries({ queryKey: ['schema-drift'] }),
  });
}

/** Whether there is anything to acknowledge. Config warnings only go away by editing config. */
export function hasSchemaChanges(drift: SchemaDrift): boolean {
  return (
    drift.addedTables.length > 0 ||
    drift.removedTables.length > 0 ||
    drift.addedColumns.length > 0 ||
    drift.removedColumns.length > 0
  );
}
