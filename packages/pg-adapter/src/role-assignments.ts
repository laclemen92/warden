import { auditDiff, type AuditStore } from '@wardenhq/core';
import { sql } from 'kysely';
import { insertAuditEntry } from './audit.js';
import type { Database } from './database.js';
import { WARDEN_SCHEMA } from './introspect.js';

const ASSIGNMENTS = sql.id(WARDEN_SCHEMA, 'role_assignments');
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
  /** The internal user id config's `actor` mapped them to. */
  userId?: string;
  roles: readonly string[];
  requestId?: string;
  /** Where the change is audited; `warden.audit_log` when absent. */
  store?: AuditStore;
}

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
  await insertAuditEntry(trx, actor.store ?? { kind: 'warden' }, {
    requestId: actor.requestId ?? null,
    actorSubject: actor.subject,
    actorEmail: actor.email ?? null,
    actorUserId: actor.userId ?? null,
    actorRoles: [...actor.roles],
    action,
    entity: ENTITY,
    primaryKey: { email, role },
    before,
    after,
    diff: auditDiff(before, after),
  });
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

/** Thrown by {@link unassignRole} instead of removing the last assignment of a protected role. */
export class LastHolderError extends Error {
  constructor(readonly role: string) {
    super(`removing it would leave no one with role "${role}"`);
    this.name = 'LastHolderError';
  }
}

/**
 * Remove `role` from `email` and audit it, in one transaction. Returns the removed assignment,
 * or `undefined` when there was none. Throws {@link LastHolderError}, changing nothing, when
 * `role` is in `protect` and no assignment of a protected role would be left.
 */
export async function unassignRole(
  db: Database,
  {
    email,
    role,
    actor,
    protect = [],
  }: { email: string; role: string; actor: AssignmentActor; protect?: readonly string[] },
): Promise<RoleAssignment | undefined> {
  return db.transaction().execute(async (trx) => {
    const guarded = protect.includes(role);
    if (guarded) {
      // Locks every protected assignment, so two removals can't each see the other's row left.
      await sql`select 1 from ${ASSIGNMENTS} where role = any(${[...protect]}) for update`.execute(
        trx,
      );
    }
    const { rows } = await sql<RoleAssignment>`
      delete from ${ASSIGNMENTS} where email = ${email} and role = ${role}
      returning ${COLUMNS}`.execute(trx);
    const assignment = rows[0];
    if (!assignment) return undefined;
    if (guarded) {
      const { rows: left } = await sql`
        select 1 from ${ASSIGNMENTS} where role = any(${[...protect]}) limit 1`.execute(trx);
      // Thrown, so the transaction rolls the delete back.
      if (left.length === 0) throw new LastHolderError(role);
    }
    await audit(trx, 'unassign', actor, assignment, null);
    return assignment;
  });
}
