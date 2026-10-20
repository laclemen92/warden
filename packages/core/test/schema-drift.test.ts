import { parseConfig, wardenConfigSchema, type WardenConfig } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  adminAreas,
  diffSchema,
  resolveSchema,
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
const id = col('id', { dataType: 'int8', formattedType: 'bigint', nullable: false });
const table = (name: string, columns: Column[], schema = 'public'): Table => ({
  schema,
  name,
  kind: 'table',
  columns: [id, ...columns],
  primaryKey: ['id'],
  uniqueKeys: [],
  foreignKeys: [],
});

const baseline: SchemaModel = {
  enums: [],
  tables: [
    table('users', [col('email'), col('legacy')]),
    table('orders', [col('status')]),
    table('old_reports', [col('body')]),
  ],
};

// Since the baseline: users gained two columns and lost one, orders gained a generated column,
// old_reports was dropped, and three tables were created.
const current: SchemaModel = {
  enums: [],
  tables: [
    table('users', [col('email'), col('nickname'), col('ssn', { formattedType: 'character(9)' })]),
    table('orders', [col('status'), col('total_cents', { dataType: 'int4', generated: true })]),
    table('invoices', [col('amount')]),
    table('true', [col('yes')]),
    table('events', [col('payload')], 'ops'),
  ],
};

const config = (input: unknown = {}) => wardenConfigSchema.parse(input);
const diff = (input: unknown = {}, before = baseline) => diffSchema(before, current, config(input));

/** Merge a drift snippet into a config the way the docs tell admins to. */
function applySnippet(base: WardenConfig, snippet: string): WardenConfig {
  const { tables } = parseConfig(`schemas: [${base.schemas.join(', ')}]\n${snippet}`, 'x.yaml');
  const merged = structuredClone(base);
  for (const [key, table] of Object.entries(tables)) {
    const existing = merged.tables[key];
    merged.tables[key] = existing
      ? { ...existing, ...table, columns: { ...existing.columns, ...table.columns } }
      : table;
  }
  return merged;
}

describe('diffSchema', () => {
  it('reports what changed since the baseline that config does not mention', () => {
    const drift = diff({ schemas: ['public', 'ops'] });
    expect(drift.addedTables).toEqual([
      { table: 'invoices', exposed: true },
      { table: 'true', exposed: true },
      { table: 'ops.events', exposed: true },
    ]);
    expect(drift.removedTables).toEqual([{ table: 'old_reports' }]);
    expect(drift.addedColumns).toEqual([
      { table: 'users', column: 'nickname', type: 'text', treatment: 'visible' },
      { table: 'users', column: 'ssn', type: 'character(9)', treatment: 'visible' },
      { table: 'orders', column: 'total_cents', type: 'text', treatment: 'readOnly' },
    ]);
    expect(drift.removedColumns).toEqual([{ table: 'users', column: 'legacy' }]);
    expect(drift.warnings).toEqual([]);
  });

  it('reports nothing when the schema matches the baseline', () => {
    const drift = diff({}, current);
    expect(drift).toMatchObject({
      addedTables: [],
      removedTables: [],
      addedColumns: [],
      removedColumns: [],
      snippet: '',
    });
  });

  it('leaves out tables and columns that config already mentions', () => {
    const drift = diff({
      tables: {
        invoices: {},
        'public.true': { hidden: true },
        users: { columns: { ssn: { hidden: true } } },
      },
    });
    expect(drift.addedTables.map((t) => t.table)).toEqual(['ops.events']);
    expect(drift.addedColumns.map((c) => c.column)).toEqual(['nickname', 'total_cents']);
  });

  it.each([
    ['visible', 'visible'],
    ['hidden', 'hidden'],
    ['readOnly', 'readOnly'],
  ] as const)('treats new columns per defaults.newColumns: %s', (newColumns, treatment) => {
    const drift = diff({ defaults: { newColumns } });
    expect(drift.addedColumns.find((c) => c.column === 'nickname')?.treatment).toBe(treatment);
    // Generated columns are never writable, whatever the default.
    expect(drift.addedColumns.find((c) => c.column === 'total_cents')?.treatment).toBe(
      newColumns === 'hidden' ? 'hidden' : 'readOnly',
    );
  });

  it('marks new tables as not exposed with expose: none and skips their columns', () => {
    const drift = diff({ defaults: { expose: 'none' }, tables: { users: {} } });
    expect(drift.addedTables).toEqual([
      { table: 'invoices', exposed: false },
      { table: 'true', exposed: false },
      { table: 'ops.events', exposed: false },
    ]);
    // orders isn't exposed, so its new column changes nothing users can see.
    expect(drift.addedColumns.map((c) => c.column)).toEqual(['nickname', 'ssn']);
    expect(drift.removedColumns).toEqual([{ table: 'users', column: 'legacy' }]);
  });

  it('skips column changes on hidden tables', () => {
    const drift = diff({ tables: { users: { hidden: true } } });
    expect(drift.addedColumns.map((c) => c.table)).toEqual(['orders']);
    expect(drift.removedColumns).toEqual([]);
  });

  it('lists config that refers to missing tables and columns', () => {
    const drift = diff({
      tables: { old_reports: { label: 'Reports' }, users: { columns: { legacy: {} } } },
      roles: { ops: { grants: { old_reports: ['read'] } } },
    });
    expect(drift.warnings).toEqual([
      { path: 'tables.old_reports', message: 'table "public.old_reports" does not exist' },
      { path: 'tables.users.columns.legacy', message: 'column "legacy" does not exist' },
      {
        path: 'roles.ops.grants.old_reports',
        message: 'table "public.old_reports" is not exposed',
      },
    ]);
  });

  it('builds a YAML snippet that quotes keys YAML would misread', () => {
    expect(diff({ schemas: ['public', 'ops'] }).snippet).toBe(
      [
        'tables:',
        '  invoices: { hidden: false }',
        '  "true": { hidden: false }',
        '  ops.events: { hidden: false }',
        '  users:',
        '    columns:',
        '      nickname: { hidden: false }',
        '      ssn: { hidden: false }',
        '  orders:',
        '    columns:',
        '      total_cents: { readOnly: true }',
        '',
      ].join('\n'),
    );

    const odd = table('odd', [col('weird: "name"\n#x'), col('Mixed Case')]);
    const drift = diffSchema(
      { enums: [], tables: [table('odd', [])] },
      { enums: [], tables: [odd] },
      config(),
    );
    const parsed = parseConfig(drift.snippet, 'snippet.yaml');
    expect(Object.keys(parsed.tables.odd?.columns ?? {})).toEqual([
      'weird: "name"\n#x',
      'Mixed Case',
    ]);
  });

  it.each([
    ['visible', 'all'],
    ['hidden', 'all'],
    ['readOnly', 'all'],
    ['visible', 'none'],
    ['hidden', 'none'],
  ] as const)(
    'resolves drift without changing the schema (newColumns: %s, expose: %s)',
    (newColumns, expose) => {
      const base = config({
        schemas: ['public', 'ops'],
        defaults: { newColumns, expose },
        tables: { users: { label: 'People' }, orders: {} },
      });
      const drift = diffSchema(baseline, current, base);
      expect(drift.snippet).not.toBe('');

      const resolved = applySnippet(base, drift.snippet);
      expect(resolveSchema(current, resolved).schema).toEqual(resolveSchema(current, base).schema);
      const after = diffSchema(baseline, current, resolved);
      expect(after.addedTables).toEqual([]);
      expect(after.addedColumns).toEqual([]);
    },
  );
});

describe('adminAreas', () => {
  const roles = config({
    roles: { dba: { admin: ['schema'] }, viewer: { grants: { '*': ['read'] } } },
  }).roles;

  it('combines the areas of every role held', () => {
    expect(adminAreas(roles, ['viewer', 'dba'])).toEqual(['schema']);
    expect(adminAreas(roles, ['viewer'])).toEqual([]);
    expect(adminAreas(roles, [])).toEqual([]);
  });

  it('ignores roles that are not defined, including prototype keys', () => {
    expect(adminAreas(roles, ['nobody', 'constructor', '__proto__', 'toString'])).toEqual([]);
  });
});
