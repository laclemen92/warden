import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  auditTableName,
  resolveAuditStore,
  resolveSchema,
  type Column,
  type Table,
} from '../src/index.js';

const col = (name: string, dataType: string, overrides: Partial<Column> = {}): Column => ({
  name,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  generated: false,
  ...overrides,
});
const notNull = { nullable: false };

/** The published DDL: `warden.audit_log`'s columns. */
const defaultColumns = (): Column[] => [
  col('id', 'int8', { ...notNull, hasDefault: true, identity: 'always' }),
  col('occurred_at', 'timestamptz', { ...notNull, hasDefault: true }),
  col('request_id', 'text'),
  col('actor_subject', 'text', notNull),
  col('actor_email', 'text'),
  col('actor_roles', 'text', { ...notNull, isArray: true, hasDefault: true }),
  col('action', 'text', notNull),
  col('entity', 'text', notNull),
  col('record_id', 'text'),
  col('primary_key', 'jsonb'),
  col('before', 'jsonb'),
  col('after', 'jsonb'),
  col('diff', 'jsonb'),
  col('details', 'jsonb'),
  col('reason', 'text'),
  col('written', 'text', { isArray: true }),
  col('parent_id', 'int8'),
];

const table = (name: string, columns: Column[], schema = 'public'): Table => ({
  schema,
  name,
  kind: 'table',
  columns,
  primaryKey: ['id'],
  uniqueKeys: [],
  foreignKeys: [],
});

const config = (audit: unknown, rest: Record<string, unknown> = {}) =>
  wardenConfigSchema.parse({ ...rest, audit });

const MINIMAL = {
  id: 'id',
  occurredAt: 'created_at',
  actorSubject: 'actor_sub',
  action: 'action',
  entity: 'table_name',
  recordId: 'record_id',
  diff: 'diff',
  details: 'details',
};
const minimalTable = (extra: Column[] = []) =>
  table('change_log', [
    col('id', 'int4', { ...notNull, hasDefault: true, sequenceDefault: true }),
    col('created_at', 'timestamp', notNull),
    col('actor_sub', 'varchar', notNull),
    col('action', 'varchar', notNull),
    col('table_name', 'text', notNull),
    col('record_id', 'text'),
    col('diff', 'json'),
    col('details', 'jsonb'),
    ...extra,
  ]);

describe('auditTableName', () => {
  it('is undefined for the warden store, and qualifies against the first schema', () => {
    expect(auditTableName(config({}))).toBeUndefined();
    expect(
      auditTableName(config({ store: 'table', table: 'change_log' }, { schemas: ['app'] })),
    ).toEqual({ schema: 'app', name: 'change_log' });
    expect(auditTableName(config({ store: 'table', table: 'audit.log' }))).toEqual({
      schema: 'audit',
      name: 'log',
    });
  });
});

describe('resolveAuditStore', () => {
  it('is the warden store by default', () => {
    expect(resolveAuditStore(config({}), undefined)).toEqual({
      store: { kind: 'warden' },
      problems: [],
    });
  });

  it('maps every field to the default column names when columns are omitted', () => {
    const { store, problems } = resolveAuditStore(
      config({ store: 'table', table: 'audit_log' }),
      table('audit_log', defaultColumns()),
    );
    expect(problems).toEqual([]);
    expect(store).toMatchObject({
      kind: 'table',
      schema: 'public',
      name: 'audit_log',
      columns: { occurredAt: 'occurred_at', parentId: 'parent_id', written: 'written' },
    });
  });

  it('accepts a minimal mapping with compatible types, and keeps the source tag', () => {
    const { store, problems } = resolveAuditStore(
      config({
        store: 'table',
        table: 'change_log',
        columns: MINIMAL,
        source: { column: 'source', value: 'warden' },
      }),
      minimalTable([col('source', 'text', { ...notNull, hasDefault: true })]),
    );
    expect(problems).toEqual([]);
    expect(store).toEqual({
      kind: 'table',
      schema: 'public',
      name: 'change_log',
      columns: MINIMAL,
      source: { column: 'source', value: 'warden' },
    });
  });

  it('is unavailable when the table is missing', () => {
    expect(resolveAuditStore(config({ store: 'table', table: 'change_log' }), undefined)).toEqual({
      store: { kind: 'unavailable' },
      problems: ['audit table "public.change_log" does not exist'],
    });
  });

  it('is unavailable, listing every problem, when columns are missing or incompatible', () => {
    const { store, problems } = resolveAuditStore(
      config({
        store: 'table',
        table: 'change_log',
        columns: { ...MINIMAL, reason: 'why', parentId: 'parent', written: 'fields' },
        source: { column: 'origin', value: 'warden' },
      }),
      table('change_log', [
        // No default: Warden never writes the id.
        col('id', 'int8', notNull),
        col('created_at', 'date', notNull),
        col('actor_sub', 'text', notNull),
        col('action', 'text', notNull),
        col('table_name', 'text', { ...notNull, generated: true, hasDefault: true }),
        // Null for exports and access entries.
        col('record_id', 'text', notNull),
        col('diff', 'text'),
        col('details', 'jsonb', { isArray: true, formattedType: 'jsonb[]' }),
        col('parent', 'uuid'),
        col('fields', 'jsonb'),
        col('origin', 'int4'),
        col('tenant_id', 'int8', notNull),
      ]),
    );
    expect(store).toEqual({ kind: 'unavailable' });
    expect(problems.map((p) => p.replace('audit table "public.change_log": ', ''))).toEqual([
      'column "id" (id) needs an identity or sequence default',
      'column "created_at" (occurredAt) is date, expected a timestamp',
      'column "table_name" (entity) is generated and can\'t be written',
      'column "record_id" (recordId) is not null, but Warden leaves it empty for some entries',
      'column "diff" (diff) is text, expected json or jsonb',
      'column "details" (details) is jsonb[], expected json or jsonb',
      'column "why" (reason) does not exist in "public.change_log"',
      'column "fields" (written) is jsonb, expected a text array',
      'column "parent" (parentId) is uuid, expected an integer',
      'source column "origin" is int4, expected text without a length limit',
      'column "tenant_id" is not null without a default, and isn\'t mapped',
    ]);
  });
});

describe('resolveSchema with an audit table', () => {
  const model = {
    enums: [],
    tables: [
      table('users', [col('id', 'int8', notNull)]),
      {
        ...minimalTable([col('user_id', 'int8')]),
        foreignKeys: [
          {
            name: 'change_log_user_id_fkey',
            columns: ['user_id'],
            references: { schema: 'public', name: 'users', columns: ['id'] },
          },
        ],
      },
    ],
  };

  it('never exposes the audit table, nor relations to it', () => {
    const { schema } = resolveSchema(
      model,
      config({ store: 'table', table: 'change_log', columns: MINIMAL }),
    );
    expect(schema.entities.map((e) => e.key)).toEqual(['users']);
    expect(schema.entities[0]!.relations).toEqual([]);
  });

  it('exposes it like any table with the warden store', () => {
    const { schema } = resolveSchema(model, config({}));
    expect(schema.entities.map((e) => e.key)).toEqual(['users', 'change_log']);
  });
});

describe('resolveAuditStore column checks', () => {
  it('rejects an id whose default is a plain value, not an identity or sequence', () => {
    const { store, problems } = resolveAuditStore(
      config({ store: 'table', table: 'change_log', columns: MINIMAL }),
      table('change_log', [
        col('id', 'int8', { ...notNull, hasDefault: true }),
        ...minimalTable().columns.slice(1),
      ]),
    );
    expect(store).toEqual({ kind: 'unavailable' });
    expect(problems).toEqual([
      'audit table "public.change_log": column "id" (id) needs an identity or sequence default',
    ]);
  });

  it('accepts an identity id without a sequence default', () => {
    const { problems } = resolveAuditStore(
      config({ store: 'table', table: 'change_log', columns: MINIMAL }),
      table('change_log', [
        col('id', 'int8', { ...notNull, hasDefault: true, identity: 'byDefault' }),
        ...minimalTable().columns.slice(1),
      ]),
    );
    expect(problems).toEqual([]);
  });

  it('rejects text columns with a length limit', () => {
    const limited = (name: string, length: number, extra: Partial<Column> = {}) =>
      col(name, 'varchar', {
        formattedType: `character varying(${length})`,
        maxLength: length,
        ...extra,
      });
    const { store, problems } = resolveAuditStore(
      config({
        store: 'table',
        table: 'change_log',
        columns: { ...MINIMAL, actorRoles: 'roles' },
        source: { column: 'source', value: 'warden' },
      }),
      table('change_log', [
        ...minimalTable().columns.filter((c) => c.name !== 'record_id'),
        limited('record_id', 36),
        col('roles', 'varchar', {
          ...notNull,
          isArray: true,
          formattedType: 'character varying(20)[]',
          maxLength: 20,
        }),
        limited('source', 10),
      ]),
    );
    expect(store).toEqual({ kind: 'unavailable' });
    expect(problems.map((p) => p.replace('audit table "public.change_log": ', ''))).toEqual([
      'column "roles" (actorRoles) is character varying(20)[], expected no length limit',
      'column "record_id" (recordId) is character varying(36), expected no length limit',
      'source column "source" is character varying(10), expected text without a length limit',
    ]);
  });
});
