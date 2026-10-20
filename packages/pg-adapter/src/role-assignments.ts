import { auditDiff } from '@wardenhq/core';
import { sql } from 'kysely';
import type { Database } from './database.js';
import { WARDEN_SCHEMA } from './introspect.js';

const ASSIGNMENTS = sql.id(WARDEN_SCHEMA, 'role_assignments');
const AUDIT_LOG = sql.id(WARDEN_SCHEMA, 'audit_log');
const ENTITY = 'warden.role_assignments';

/** A role given to a user in the app. A type, not an interface, so it can be audited as a row. */
export type RoleAssignment = {
  /** Lowercased; matched against the user's verified email claim. */
  email: string;
  role: string;
  /** OIDC subject of the admin who assigned it. */
  assignedBy: string;
  assignedAt: string;
};

export interface AssignmentActor {
  subject: string;
  email?: string;
  roles: readonly string[];
  requestId?: string;
}

const json = (value: unknown) => (value === null ? null : JSON.stringify(value));

const COLUMNS = sql`email, role, assigned_by as "assignedBy", assigned_at as "assignedAt"`;

export async function listRoleAssignments(db: Database): Promise<RoleAssignment[]> {
  const { rows } = await sql<RoleAssignment>`
    select ${COLUMNS} from ${ASSIGNMENTS} order by email, role`.execute(db);
  return rows;
}

/** Roles assigned to `email` (already lowercased), whether or not config still defines them. */
export async function assignedRoles(db: Database, email: string): Promise<string[]> {
  const { rows } = await sql<{ role: string }>`
    select role from ${ASSIGNMENTS} where email = ${email} order by role`.execute(db);
  return rows.map((r) => r.role);
}

async function audit(
  trx: Database,
  action: 'assign' | 'unassign',
  actor: AssignmentActor,
  before: RoleAssignment | null,
  after: RoleAssignment | null,
) {
  const { email, role } = (after ?? before)!;
  await sql`
    insert into ${AUDIT_LOG}
      (request_id, actor_subject, actor_email, actor_roles, action, entity, primary_key,
       before, after, diff)
    values (${actor.requestId ?? null}, ${actor.subject}, ${actor.email ?? null},
            ${[...actor.roles]}, ${action}, ${ENTITY}, ${json({ email, role })}::jsonb,
            ${json(before)}::jsonb, ${json(after)}::jsonb,
            ${json(auditDiff(before, after))}::jsonb)`.execute(trx);
}

/**
 * Assign `role` to `email` and audit it, in one transaction. Returns `undefined` without
 * changing anything when the user already has that assignment.
 */
export async function assignRole(
  db: Database,
  { email, role, actor }: { email: string; role: string; actor: AssignmentActor },
): Promise<RoleAssignment | undefined> {
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<RoleAssignment>`
      insert into ${ASSIGNMENTS} (email, role, assigned_by)
      values (${email}, ${role}, ${actor.subject})
      on conflict do nothing
      returning ${COLUMNS}`.execute(trx);
    const assignment = rows[0];
    if (assignment) await audit(trx, 'assign', actor, null, assignment);
    return assignment;
  });
}

/**
 * Remove `role` from `email` and audit it, in one transaction. Returns the removed assignment,
 * or `undefined` when there was none.
 */
export async function unassignRole(
  db: Database,
  { email, role, actor }: { email: string; role: string; actor: AssignmentActor },
): Promise<RoleAssignment | undefined> {
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<RoleAssignment>`
      delete from ${ASSIGNMENTS} where email = ${email} and role = ${role}
      returning ${COLUMNS}`.execute(trx);
    const assignment = rows[0];
    if (assignment) await audit(trx, 'unassign', actor, assignment, null);
    return assignment;
  });
}
