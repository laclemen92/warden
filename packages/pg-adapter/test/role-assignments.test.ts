import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignedRoles,
  assignRole,
  createDatabase,
  listAuditEntries,
  listRoleAssignments,
  migrate,
  unassignRole,
  type DatabaseHandle,
} from '../src/index.js';

let pgContainer: TestDatabase;
let handle: DatabaseHandle;

const actor = { subject: 'admin', email: 'admin@example.com', roles: ['admin'], requestId: 'r1' };

beforeAll(async () => {
  pgContainer = await startPostgres();
  handle = createDatabase({ connectionString: pgContainer.connectionString });
  await migrate(handle.db);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

const auditEntries = async () => {
  const { rows } = await sql<Record<string, unknown>>`
    select request_id, actor_subject, actor_email, actor_roles, action, entity, record_id,
           primary_key, before, after, diff
    from warden.audit_log where entity = 'warden.role_assignments' order by id`.execute(handle.db);
  return rows;
};

describe('role assignments', () => {
  it('assigns a role once and audits it', async () => {
    const assigned = await assignRole(handle.db, { email: 'u@example.com', role: 'ops', actor });
    expect(assigned).toMatchObject({ email: 'u@example.com', role: 'ops', assignedBy: 'admin' });
    expect(typeof assigned?.assignedAt).toBe('string');

    // Already assigned: nothing changes and nothing is audited.
    expect(
      await assignRole(handle.db, { email: 'u@example.com', role: 'ops', actor }),
    ).toBeUndefined();
    await assignRole(handle.db, { email: 'u@example.com', role: 'admin', actor });

    expect(await assignedRoles(handle.db, 'u@example.com')).toEqual(['admin', 'ops']);
    expect(await assignedRoles(handle.db, 'other@example.com')).toEqual([]);
    expect(await listRoleAssignments(handle.db)).toHaveLength(2);

    const [entry] = await auditEntries();
    expect(entry).toEqual({
      request_id: 'r1',
      actor_subject: 'admin',
      actor_email: 'admin@example.com',
      actor_roles: ['admin'],
      action: 'assign',
      entity: 'warden.role_assignments',
      record_id: null,
      primary_key: { email: 'u@example.com', role: 'ops' },
      before: null,
      after: assigned,
      diff: {
        email: { from: null, to: 'u@example.com' },
        role: { from: null, to: 'ops' },
        assignedBy: { from: null, to: 'admin' },
        assignedAt: { from: null, to: assigned?.assignedAt },
      },
    });
  });

  it('lists the audit entries only when access entries are asked for', async () => {
    // Even with a visible entity that happens to share a field name.
    const query = { visible: { users: ['email', 'role'] }, limit: 50 };
    expect((await listAuditEntries(handle.db, query)).entries).toEqual([]);
    const { entries } = await listAuditEntries(handle.db, { ...query, includeAccessEntries: true });
    expect(entries.map((e) => [e.action, e.after?.role])).toEqual([
      ['assign', 'admin'],
      ['assign', 'ops'],
    ]);
    // Shown in full: these aren't an entity's fields, so nothing is projected away.
    expect(Object.keys(entries[0]!.after!).sort()).toEqual([
      'assignedAt',
      'assignedBy',
      'email',
      'role',
    ]);
    // Other entries under warden.* entities stay out.
    await sql`insert into warden.audit_log (actor_subject, action, entity, diff)
              values ('x', 'acknowledge', 'warden.schema_snapshots', '{}'),
                     ('x', 'update', 'warden.sessions', '{}')`.execute(handle.db);
    expect(
      (await listAuditEntries(handle.db, { ...query, includeAccessEntries: true })).entries,
    ).toHaveLength(2);
  });

  it('unassigns and audits it, once', async () => {
    const change = { email: 'u@example.com', role: 'ops', actor };
    const removed = await unassignRole(handle.db, change);
    expect(removed).toMatchObject({ email: 'u@example.com', role: 'ops' });
    expect(await unassignRole(handle.db, change)).toBeUndefined();
    expect(await assignedRoles(handle.db, 'u@example.com')).toEqual(['admin']);

    const entries = await auditEntries();
    expect(entries.map((e) => e.action)).toEqual(['assign', 'assign', 'unassign']);
    expect(entries.at(-1)).toMatchObject({ before: removed, after: null });
  });

  it('rolls back the assignment when the audit entry fails', async () => {
    // Fails the audit insert, standing in for a full disk or a revoked grant. `not valid`
    // because earlier tests already logged assignments.
    await sql`
      alter table warden.audit_log add constraint no_assign check (action <> 'assign') not valid
    `.execute(handle.db);
    try {
      await expect(
        assignRole(handle.db, { email: 'v@example.com', role: 'ops', actor }),
      ).rejects.toThrow();
      expect(await assignedRoles(handle.db, 'v@example.com')).toEqual([]);
    } finally {
      await sql`alter table warden.audit_log drop constraint no_assign`.execute(handle.db);
    }
  });

  it('only stores lowercased emails', async () => {
    await expect(
      sql`insert into warden.role_assignments (email, role, assigned_by)
          values ('U@Example.com', 'ops', 'admin')`.execute(handle.db),
    ).rejects.toThrow(/check constraint/);
  });
});
