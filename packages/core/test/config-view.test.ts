import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  configViewState,
  resolveConfigViews,
  resolveSchema,
  toExportedView,
  viewEntryYaml,
  viewKeyFor,
  viewsConfigYaml,
  type Column,
  type SchemaModel,
  type ViewState,
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

const model: SchemaModel = {
  enums: [],
  tables: [
    {
      schema: 'public',
      name: 'payouts',
      kind: 'table',
      primaryKey: ['id'],
      uniqueKeys: [],
      foreignKeys: [],
      columns: [
        col('id', { dataType: 'int8', formattedType: 'bigint', nullable: false }),
        col('status'),
        col('amount', { dataType: 'numeric', formattedType: 'numeric' }),
        col('secret'),
        col('meta', { dataType: 'jsonb', formattedType: 'jsonb' }),
        col('created_at', { dataType: 'timestamptz', formattedType: 'timestamptz' }),
      ],
    },
  ],
};

const resolve = (yaml: string) => {
  const config = parseConfig(yaml, 'warden.config.yaml');
  const { schema } = resolveSchema(model, config);
  return resolveConfigViews(model, schema, config);
};

const withView = (view: string, columns = 'secret: { hidden: true }') => `
tables:
  payouts:
    columns: { ${columns} }
    views:
      - ${view}
`;

describe('resolveConfigViews', () => {
  it('turns valid views into view states', () => {
    const result = resolve(`
tables:
  payouts:
    views:
      - key: review
        name: Review queue
        filter: { and: [{ field: status, op: eq, value: IN_REVIEW }, { field: amount, op: gt, value: 10 }] }
        search: big
        sort: [{ column: created_at }, { column: amount, direction: desc }]
        columns: [id, amount]
        sidebar: true
        default: true
`);
    expect(result).toEqual({
      errors: [],
      warnings: [],
      views: [
        {
          key: 'review',
          entity: 'payouts',
          name: 'Review queue',
          state: {
            filter: {
              and: [
                { field: 'status', op: 'eq', value: 'IN_REVIEW' },
                { field: 'amount', op: 'gt', value: 10 },
              ],
            },
            q: 'big',
            sort: 'created_at,-amount',
            columns: ['id', 'amount'],
          },
          sidebar: true,
          default: true,
        },
      ],
    });
  });

  it('fails on columns hidden by config, wherever they are used', () => {
    const result = resolve(
      withView(
        `{ key: a, name: A, filter: { not: { field: secret, op: isNull } }, sort: [{ column: secret }], columns: [id, secret] }`,
      ),
    );
    expect(result.views).toEqual([]);
    expect(result.errors.map((e) => e.path.join('.'))).toEqual([
      'tables.payouts.views.0.columns.1',
      'tables.payouts.views.0.sort.0.column',
      'tables.payouts.views.0.filter.not.field',
    ]);
    expect(result.errors[0]!.message).toBe(
      'column "secret" is hidden and cannot be used in a view',
    );

    // Hidden by defaults.newColumns counts too.
    const hiddenByDefault = resolve(`
defaults: { newColumns: hidden }
tables:
  payouts:
    columns: { id: {} }
    views: [{ key: a, name: A, columns: [status] }]
`);
    expect(hiddenByDefault.errors).toHaveLength(1);
  });

  it('disables views naming columns the database does not have, with a warning', () => {
    const result = resolve(withView(`{ key: a, name: A, columns: [id, dropped] }`));
    expect(result).toEqual({
      views: [],
      errors: [],
      warnings: [
        {
          path: 'tables.payouts.views.0',
          message: 'view "a" is disabled: column "dropped" does not exist',
        },
      ],
    });
  });

  it('reports invalid filters, sorts and columns with their paths', () => {
    const bad = (view: string) => resolve(withView(view)).errors;
    expect(bad(`{ key: a, name: A, filter: { field: amount, op: contains, value: x } }`)).toEqual([
      expect.objectContaining({ path: ['tables', 'payouts', 'views', 0, 'filter', 'op'] }),
    ]);
    expect(bad(`{ key: a, name: A, filter: { field: status, op: nope } }`)).not.toEqual([]);
    expect(bad(`{ key: a, name: A, filter: [] }`)).not.toEqual([]);
    expect(bad(`{ key: a, name: A, sort: [{ column: meta }] }`)).toEqual([
      { path: ['tables', 'payouts', 'views', 0, 'sort'], message: 'cannot sort by "meta"' },
    ]);
    expect(bad(`{ key: a, name: A, columns: [id, id] }`)).toEqual([
      expect.objectContaining({ path: ['tables', 'payouts', 'views', 0, 'columns', 1] }),
    ]);
  });

  it('warns about views of tables the database does not have', () => {
    const result = resolve(`
tables:
  gone:
    views: [{ key: a, name: A }]
`);
    expect(result.views).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ path: 'tables.gone.views.0' })]);
  });
});

describe('config view validation', () => {
  const issues = (yaml: string) => {
    try {
      parseConfig(yaml, 'warden.config.yaml');
      return [];
    } catch (err) {
      return (err as { issues: { path: string; message: string; line?: number }[] }).issues;
    }
  };

  it('requires unique keys across tables and one default per table', () => {
    expect(
      issues(`
tables:
  payouts:
    views:
      - { key: a, name: A, default: true }
      - { key: b, name: B, default: true }
  orders:
    views:
      - { key: a, name: Again }
`),
    ).toEqual([
      expect.objectContaining({ path: 'tables.payouts.views.1.default', line: 6 }),
      expect.objectContaining({ path: 'tables.orders.views.0.key', line: 9 }),
    ]);
  });

  it('rejects bad keys, hidden tables, and views when shared views come from the UI', () => {
    expect(issues(`tables: { a: { views: [{ key: Bad Key, name: A }] } }`)).toEqual([
      expect.objectContaining({ path: 'tables.a.views.0.key' }),
    ]);
    expect(issues(`tables: { a: { hidden: true, views: [{ key: a, name: A }] } }`)).toEqual([
      expect.objectContaining({ path: 'tables.a.views' }),
    ]);
    expect(
      issues(`
defaults: { sharedViews: ui }
tables: { a: { views: [{ key: a, name: A }] } }
`),
    ).toEqual([expect.objectContaining({ path: 'tables.a.views.0' })]);
  });
});

describe('Export to config', () => {
  const states: ViewState[] = [
    {
      filter: {
        and: [
          { field: 'status', op: 'in', value: ['IN_REVIEW', 'true', '12', 'a: b # c'] },
          {
            or: [
              { field: 'amount', op: 'gte', value: 10.5 },
              { not: { field: 'created_at', op: 'isNull' } },
              { field: 'status', op: 'eq', value: 'quote"s\\ and \u0085 and ünïcode' },
            ],
          },
        ],
      },
      q: 'needle',
      sort: '-created_at,amount,id',
      columns: ['id', 'status', 'amount'],
    },
    { filter: { field: 'status', op: 'eq', value: 'null' } },
    {},
  ];

  it.each(states.map((state, i) => [i, state] as const))(
    'round-trips state %i through loadConfig',
    async (_, state) => {
      const exported = toExportedView('review-queue', 'Review: "queue"', state);
      const yaml = viewsConfigYaml([{ table: 'payouts', views: [exported] }]);
      const dir = mkdtempSync(join(tmpdir(), 'warden-export-'));
      writeFileSync(join(dir, 'warden.config.yaml'), yaml);
      const { config } = await loadConfig({ cwd: dir, env: {} });
      const [view] = config.tables.payouts!.views!;
      expect(view).toMatchObject({ key: 'review-queue', name: 'Review: "queue"' });
      expect(configViewState(view!)).toEqual(state);
      expect(resolveConfigViews(model, resolveSchema(model, config).schema, config)).toMatchObject({
        errors: [],
        views: [{ state }],
      });
    },
  );

  it('writes an entry to paste under tables.<table>.views', () => {
    const entry = viewEntryYaml(
      toExportedView('fraud-review', 'Fraud review queue', {
        filter: { field: 'status', op: 'eq', value: 'IN_REVIEW' },
        sort: 'created_at',
        columns: ['id', 'amount'],
      }),
    );
    expect(entry).toBe(
      [
        '- key: fraud-review',
        '  name: Fraud review queue',
        '  filter: { field: status, op: eq, value: IN_REVIEW }',
        '  sort:',
        '    - { column: created_at, direction: asc }',
        '  columns: [id, amount]',
        '',
      ].join('\n'),
    );
    const indented = entry.replace(/^/gm, '      ');
    const config = parseConfig(`tables:\n  payouts:\n    views:\n${indented}`, 'x.yaml');
    expect(config.tables.payouts!.views![0]!.key).toBe('fraud-review');
  });

  it('exports several tables as one config section', () => {
    const yaml = viewsConfigYaml([
      { table: 'payouts', views: [toExportedView('a', 'A', {}), toExportedView('b', 'B', {})] },
      { table: 'billing.invoices', views: [toExportedView('c', 'C', { q: 'x' })] },
    ]);
    const config = parseConfig(`schemas: [public, billing]\n${yaml}`, 'x.yaml');
    expect(Object.keys(config.tables)).toEqual(['payouts', 'billing.invoices']);
    expect(config.tables['billing.invoices']!.views).toEqual([
      { key: 'c', name: 'C', search: 'x' },
    ]);
  });

  it('makes keys from names', () => {
    expect(viewKeyFor('Fraud review queue')).toBe('fraud-review-queue');
    expect(viewKeyFor('  Ünïcode & co.  ')).toBe('unicode-co');
    expect(viewKeyFor('!!!')).toBe('view');
    expect(viewKeyFor('A', new Set(['a', 'a-2']))).toBe('a-3');
  });
});
