import type { Action, AdminArea } from '@wardenhq/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';
import { useCurrentUser } from './auth';

export const ROLES_PATH = '/admin/roles';
const ROLES_URL = '/api/admin/roles';
const ASSIGNMENTS_URL = '/api/admin/roles/assignments';

export interface RoleDefinition {
  name: string;
  grants: Record<string, Action[]>;
  admin: AdminArea[];
}

export interface RoleAssignment {
  email: string;
  role: string;
  assignedBy: string;
  assignedAt: string;
  /** False when config no longer defines the role, so the assignment has no effect. */
  defined: boolean;
}

export interface RolesReport {
  roles: RoleDefinition[];
  /** Config's `access` rules; null when config has none and every IdP user may sign in. */
  access: { groups: Record<string, string[]>; emailDomains: Record<string, string[]> } | null;
  assignments: RoleAssignment[];
}

export interface AssignmentInput {
  email: string;
  role: string;
}

/** Whether the current user may open the roles page. The server enforces it either way. */
export function useCanManageRoles(): boolean {
  const { data: me } = useCurrentUser();
  return me?.admin?.includes('roles') ?? false;
}

export function useRoles() {
  return useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => apiFetch<RolesReport>(ROLES_URL),
  });
}

function useAssignmentMutation(method: 'POST' | 'DELETE') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignmentInput) =>
      apiFetch<unknown>(ASSIGNMENTS_URL, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    // Refetch on failure too: a conflict or missing assignment means the list is stale. The
    // admin may have changed their own roles, so refresh those as well.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-roles'] }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
      ]),
  });
}

export const useAssignRole = () => useAssignmentMutation('POST');
export const useUnassignRole = () => useAssignmentMutation('DELETE');

/** A role's grants as short lines, e.g. `users: read, update`. */
export function describeGrants(grants: RoleDefinition['grants']): string[] {
  return Object.entries(grants).map(([table, actions]) => `${table}: ${actions.join(', ')}`);
}
