export {
  createDatabase,
  type Database,
  type DatabaseHandle,
  type DatabaseOptions,
} from './database.js';
export { compileFilter, escapeLike } from './filter.js';
export { introspect, WARDEN_SCHEMA, type IntrospectOptions } from './introspect.js';
export { getRow, listRows, type ListOptions, type ListResult, type Row } from './rows.js';
export {
  createRow,
  deleteRow,
  rowVersion,
  updateRow,
  type WriteAction,
  type WriteChange,
  type WriteHook,
  type WriteOptions,
  type VersionCheck,
  type WriteResult,
} from './writes.js';
export {
  AuditWriteError,
  auditHook,
  listAuditEntries,
  type AuditContext,
  type AuditPage,
  type AuditQuery,
} from './audit.js';
export { mapWriteError, type WriteErrorResult } from './errors.js';
export { migrate, MIGRATIONS, pendingMigrations, type Migration } from './migrate.js';
export {
  deleteExpiredSessions,
  deleteSession,
  insertSession,
  touchSession,
  type NewSession,
  type Session,
  type SessionTimeouts,
} from './sessions.js';
export {
  assignedRoles,
  assignRole,
  listRoleAssignments,
  unassignRole,
  type AssignmentActor,
  type RoleAssignment,
} from './role-assignments.js';
export {
  acknowledgeSchemaSnapshot,
  ensureSchemaSnapshot,
  latestSchemaSnapshot,
  type SchemaSnapshot,
  type SnapshotActor,
} from './snapshots.js';
