import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  deleteCascadeWarnings,
  isAllowed,
  isSoftDeleteDetails,
  projectAuditEntry,
  resolvePolicy,
  resolveSchema,
  schemaFor,
  type AuditEntry,
  type Column,
  type SchemaModel,
  type Table,
} from '../src/index.js';

const col = (name: string, overrides: Partial<Column> = {}): Column => ({
  name,
  dataType: 'text',
  formattedType: 'text',
  isArray: false,
  nullable: true,
  hasDefault: false,
  generated: false,
  ...overrides,
});
const ts = (name: string, overrides: Partial<Column> = {}) =>
  col(name, { dataType: 'timestamptz', formattedType: 'timestamp with time zone', ...overrides });
const id = col('id', { dataType: 'int8', formattedType: 'bigint', nullable: false });
const table = (name: string, columns: Column[], overrides: Partial<Table> = {}): Table => ({
  schema: 'public',
  name,
  kind: 'table',
  columns: [id, ...columns],
  primaryKey: ['id'],
  uniqueKeys: [],
  foreignKeys: [],
  ...overrides,
});

const model: SchemaModel = {
  enums: [],
  tables: [
    table('certificates', [col('name'), ts('deleted_at'), col('deleted_by')]),
    table('notes', [
      col('body'),
      col('is_deleted', { dataType: 'bool', formattedType: 'boolean' }),
    ]),
    table('plain', [col('name')]),
    table('lines', [col('certificate_id', { dataType: 'int8', formattedType: 'bigint' })], {
      foreignKeys: [
        {
          name: 'lines_certificate_id_fkey',
          columns: ['certificate_id'],
          references: { schema: 'public', name: 'certificates', columns: ['id'] },
          onDelete: 'cascade',
        },
      ],
    }),
    table('odd', [
      col('deleted_at'),
      ts('stamp_not_null', { nullable: false }),
      ts('stamps', { isArray: true }),
      ts('stamp_generated', { generated: true }),
      ts('stamp'),
      col('by_not_null', { nullable: false }),
      col('flag_no_default', { dataType: 'bool', formattedType: 'boolean', nullable: false }),
    ]),
  ],
};

const parse = (config: unknown) => wardenConfigSchema.parse(config);
const resolve = (config: unknown) => {
  const parsed = parse(config);
  const { schema, warnings } = resolveSchema(model, parsed);
  const policy = resolvePolicy(schema, parsed);
  return { schema, warnings, policy: policy.policy, policyWarnings: policy.warnings };
};
const entity = (config: unknown, key: string) =>
  resolve(config).schema.entities.find((e) => e.key === key)!;

const ACTOR = { table: 'plain', matchColumn: 'name', idColumn: 'id' };

describe('resolving softDelete', () => {
  it('describes timestamp and boolean columns, with and without `by`', () => {
    const config = {
      actor: ACTOR,
      tables: {
        certificates: { softDelete: { column: 'deleted_at', by: 'deleted_by' } },
        notes: { softDelete: { column: 'is_deleted' } },
      },
    };
    expect(entity(config, 'certificates').softDelete).toEqual({
      column: 'deleted_at',
      kind: 'timestamp',
      by: 'deleted_by',
    });
    expect(entity(config, 'notes').softDelete).toEqual({ column: 'is_deleted', kind: 'boolean' });
    expect(entity(config, 'plain').softDelete).toBeUndefined();
    expect(resolve(config).warnings).toEqual([]);
  });

  it('makes its columns read-only, so only delete and restore write them', () => {
    const config = {
      actor: ACTOR,
      tables: {
        certificates: { softDelete: { column: 'deleted_at', by: 'deleted_by' } },
        notes: { softDelete: { column: 'is_deleted' } },
      },
    };
    const readOnly = (key: string) =>
      Object.fromEntries(entity(config, key).fields.map((f) => [f.name, f.readOnly]));
    expect(readOnly('certificates')).toEqual({
      id: false,
      name: false,
      deleted_at: true,
      deleted_by: true,
    });
    expect(readOnly('notes')).toMatchObject({ is_deleted: true, body: false });
    // Without soft delete they stay ordinary columns.
    expect(readOnly('plain')).toEqual({ id: false, name: false });
    expect(
      Object.fromEntries(entity({}, 'certificates').fields.map((f) => [f.name, f.readOnly])),
    ).toMatchObject({ deleted_at: false, deleted_by: false });
  });

  it('never detects a deleted_at column on its own', () => {
    expect(entity({}, 'certificates').softDelete).toBeUndefined();
  });

  it('turns soft delete off, with a warning, when the columns do not fit', () => {
    const cases: [object, string, string][] = [
      [{ column: 'nope' }, 'column', 'column "nope" does not exist'],
      [{ column: 'deleted_at' }, 'column', 'column "deleted_at" is text; expected a timestamp'],
      [{ column: 'stamp_not_null' }, 'column', 'column "stamp_not_null" is not nullable'],
      [{ column: 'stamps' }, 'column', 'column "stamps" is an array'],
      [{ column: 'stamp_generated' }, 'column', 'column "stamp_generated" is generated'],
      [{ column: 'id' }, 'column', 'column "id" is part of the primary key'],
      [{ column: 'stamp', by: 'nope' }, 'by', 'column "nope" does not exist'],
      [{ column: 'stamp', by: 'by_not_null' }, 'by', 'column "by_not_null" is not nullable'],
      [
        { column: 'flag_no_default' },
        'column',
        'column "flag_no_default" is not nullable and has no default',
      ],
    ];
    for (const [softDelete, key, message] of cases) {
      const { schema, warnings } = resolve({ actor: ACTOR, tables: { odd: { softDelete } } });
      expect(schema.entities.find((e) => e.key === 'odd')!.softDelete).toBeUndefined();
      expect(warnings).toEqual([
        {
          path: `tables.odd.softDelete.${key}`,
          message: expect.stringMatching(
            new RegExp(`^${message.replace(/[[\]().]/g, '\\$&')}.*; soft delete is off`),
          ),
        },
      ]);
    }
  });

  it('turns soft delete off when newColumns hides the column', () => {
    const { schema, warnings } = resolve({
      defaults: { newColumns: 'hidden' },
      tables: {
        certificates: { softDelete: { column: 'deleted_at' }, columns: { name: {} } },
      },
    });
    expect(schema.entities.find((e) => e.key === 'certificates')!.softDelete).toBeUndefined();
    expect(warnings).toEqual([
      {
        path: 'tables.certificates.softDelete.column',
        message: 'column "deleted_at" is not visible; soft delete is off for this table',
      },
    ]);
  });

  it('warns that `by` stays null without an actor mapping', () => {
    const { schema, warnings } = resolve({
      tables: { certificates: { softDelete: { column: 'deleted_at', by: 'deleted_by' } } },
    });
    expect(schema.entities.find((e) => e.key === 'certificates')!.softDelete?.by).toBe(
      'deleted_by',
    );
    expect(warnings).toEqual([
      {
        path: 'tables.certificates.softDelete.by',
        message: 'is always set to null: `actor` is not configured',
      },
    ]);
  });

  it('keeps soft delete in every role view, read-only columns included', () => {
    const config = parse({
      roles: { viewer: { grants: { '*': ['read'] } } },
      tables: {
        certificates: {
          softDelete: { column: 'deleted_at' },
          columns: { deleted_at: { readOnly: true }, name: { writableBy: ['viewer'] } },
        },
      },
    });
    const { schema } = resolveSchema(model, config);
    const { policy } = resolvePolicy(schema, config);
    const view = schemaFor(schema, policy, ['viewer']).entities.find(
      (e) => e.key === 'certificates',
    );
    expect(view?.softDelete).toEqual({ column: 'deleted_at', kind: 'timestamp' });
  });
});

describe('soft delete and the delete policy', () => {
  const ROLES = {
    ops: { grants: { '*': ['read', 'update'], certificates: ['delete'], plain: ['delete'] } },
    viewer: { grants: { '*': ['read'] } },
  };

  it('allows a granted delete while hard delete stays off', () => {
    const { policy, policyWarnings } = resolve({
      roles: ROLES,
      tables: { certificates: { softDelete: { column: 'deleted_at' } } },
    });
    expect(isAllowed(policy, ['ops'], 'certificates', 'delete')).toBe(true);
    expect(isAllowed(policy, ['ops'], 'plain', 'delete')).toBe(false);
    // Custom actions still may not hard-delete there.
    expect(policy.deleteOff.has('certificates')).toBe(true);
    expect(policyWarnings.map((w) => w.path)).toEqual(['roles.ops.grants.plain']);
  });

  it('still needs a grant naming the table', () => {
    const { policy } = resolve({
      roles: ROLES,
      tables: { certificates: { softDelete: { column: 'deleted_at' } } },
    });
    expect(isAllowed(policy, ['viewer'], 'certificates', 'delete')).toBe(false);
    expect(isAllowed(policy, [], 'certificates', 'delete')).toBe(false);
  });

  it('lets a table deny beat it', () => {
    const { policy } = resolve({
      roles: ROLES,
      tables: { certificates: { softDelete: { column: 'deleted_at' }, deny: ['delete'] } },
    });
    expect(isAllowed(policy, ['ops'], 'certificates', 'delete')).toBe(false);
    expect(allowedActions(policy, ['ops'], 'certificates')).toEqual(['read', 'update']);
  });

  it('falls back to the hard delete rules when soft delete is off', () => {
    const { policy } = resolve({
      roles: ROLES,
      tables: { certificates: { softDelete: { column: 'name' } } },
    });
    expect(isAllowed(policy, ['ops'], 'certificates', 'delete')).toBe(false);
  });

  it("doesn't warn about cascades a role's soft delete never triggers", () => {
    const config = parse({
      roles: ROLES,
      tables: { certificates: { softDelete: { column: 'deleted_at' }, allowDelete: true } },
    });
    const { schema } = resolveSchema(model, config);
    const { policy } = resolvePolicy(schema, config);
    expect(deleteCascadeWarnings(model, schema, policy)).toEqual([]);
    // A custom action's delete is still a hard delete.
    expect(deleteCascadeWarnings(model, schema, policy, new Set(['certificates']))).toHaveLength(1);
  });
});

describe('soft delete audit details', () => {
  const entry = (details: unknown): AuditEntry => ({
    id: '1',
    occurredAt: '2026-01-01T00:00:00Z',
    requestId: null,
    actor: { subject: 's', email: null },
    action: 'delete',
    entity: 'certificates',
    recordId: '1',
    reason: 'no longer valid',
    before: { id: '1', deleted_at: null },
    after: { id: '1', deleted_at: '2026-01-01 00:00:00+00' },
    diff: { deleted_at: { from: null, to: '2026-01-01 00:00:00+00' } },
    details: details as AuditEntry['details'],
    parent: null,
  });

  it('keeps the flag through projection and drops anything else', () => {
    expect(
      projectAuditEntry(entry({ softDelete: 'delete', extra: 'x' }), ['id', 'deleted_at']).details,
    ).toEqual({ softDelete: 'delete' });
    expect(projectAuditEntry(entry({ softDelete: 'nope' }), ['id']).details).toBeNull();
    expect(isSoftDeleteDetails({ softDelete: 'restore' })).toBe(true);
    expect(isSoftDeleteDetails(null)).toBe(false);
  });
});
