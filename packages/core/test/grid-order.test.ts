import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  defaultSortOf,
  gridColumnOrder,
  resolvePolicy,
  resolveSchema,
  resolveSort,
  schemaFor,
  type Column,
  type Entity,
  type Field,
  type SchemaModel,
} from '../src/index.js';

const field = (name: string, dataType = 'text', extra: Partial<Field> = {}): Field => ({
  name,
  label: name,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  readOnly: false,
  ...extra,
});

const entity = (fields: Field[], extra: Partial<Entity> = {}): Entity => ({
  key: 'things',
  schema: 'public',
  name: 'things',
  kind: 'table',
  label: 'Things',
  primaryKey: ['id'],
  displayField: 'id',
  searchable: [],
  relations: [],
  fields,
  ...extra,
});

describe('gridColumnOrder', () => {
  it('puts the key, display field and timestamps first, then the rest in table order', () => {
    const e = entity(
      [
        field('deleted_at', 'timestamptz'),
        field('deleted_by_user_id', 'int8'),
        field('updated_at', 'timestamptz'),
        field('name'),
        field('id', 'int8'),
        field('notes'),
        field('created_at', 'timestamptz'),
      ],
      { displayField: 'name' },
    );
    expect(gridColumnOrder(e)).toEqual([
      'id',
      'name',
      'created_at',
      'updated_at',
      'deleted_at',
      'deleted_by_user_id',
      'notes',
    ]);
  });

  it('orders composite keys in key order and skips a display field that is the key', () => {
    const e = entity([field('note'), field('b', 'int4'), field('a', 'int4'), field('createdAt')], {
      primaryKey: ['a', 'b'],
      displayField: 'a',
    });
    expect(gridColumnOrder(e)).toEqual(['a', 'b', 'createdAt', 'note']);
  });

  it('puts configured columns first, then the default order', () => {
    const e = entity(
      [field('notes'), field('id', 'int8'), field('status'), field('created_at', 'timestamptz')],
      { columnOrder: ['status', 'notes'] },
    );
    expect(gridColumnOrder(e)).toEqual(['status', 'notes', 'id', 'created_at']);
  });

  it('keeps table order for tables without a primary key', () => {
    const e = entity([field('notes'), field('name'), field('created_at', 'timestamptz')], {
      primaryKey: [],
      displayField: 'name',
    });
    expect(gridColumnOrder(e)).toEqual(['notes', 'name', 'created_at']);
    expect(gridColumnOrder({ ...e, columnOrder: ['created_at'] })).toEqual([
      'created_at',
      'notes',
      'name',
    ]);
  });

  it('never returns names that are not fields', () => {
    const e = entity([field('id', 'int8')], { columnOrder: ['secret'], displayField: 'gone' });
    expect(gridColumnOrder(e)).toEqual(['id']);
  });
});

describe('defaultSortOf', () => {
  it('prefers the configured default sort', () => {
    const e = entity([field('id', 'int8'), field('created_at', 'timestamptz')], {
      defaultSort: { column: 'id', direction: 'asc' },
    });
    expect(defaultSortOf(e)).toEqual({ field: 'id', direction: 'asc' });
  });

  it('sorts newest first by a creation timestamp', () => {
    for (const name of ['created_at', 'createdAt', 'inserted_at', 'insertedAt']) {
      const e = entity([
        field('id', 'int8'),
        field('updated_at', 'timestamptz'),
        field(name, 'date'),
      ]);
      expect(defaultSortOf(e)).toEqual({ field: name, direction: 'desc' });
    }
  });

  it('prefers created_at over inserted_at', () => {
    const e = entity([
      field('id', 'int8'),
      field('inserted_at', 'timestamptz'),
      field('created_at', 'timestamptz'),
    ]);
    expect(defaultSortOf(e)).toEqual({ field: 'created_at', direction: 'desc' });
  });

  it('ignores columns that are not timestamps, and tables without a key', () => {
    expect(defaultSortOf(entity([field('id', 'int8'), field('created_at', 'text')]))).toBe(
      undefined,
    );
    expect(
      defaultSortOf(
        entity([field('id', 'int8'), field('created_at', 'timestamptz', { isArray: true })]),
      ),
    ).toBe(undefined);
    expect(defaultSortOf(entity([field('updated_at', 'timestamptz')]))).toBe(undefined);
    expect(defaultSortOf(entity([field('created_at', 'timestamptz')], { primaryKey: [] }))).toBe(
      undefined,
    );
  });

  it('is what resolveSort falls back to, still ending in the primary key', () => {
    const e = entity([field('id', 'int8'), field('created_at', 'timestamptz')]);
    expect(resolveSort(e)).toEqual({
      ok: true,
      sort: [
        { field: 'created_at', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
    });
    expect(resolveSort(e, 'id')).toEqual({ ok: true, sort: [{ field: 'id', direction: 'asc' }] });
    const keyless = entity([field('created_at', 'timestamptz')], { primaryKey: [] });
    expect(resolveSort(keyless)).toEqual({ ok: true, sort: [] });
  });
});

const column = (name: string, dataType = 'text'): Column => ({
  name,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  generated: false,
});

const model: SchemaModel = {
  enums: [],
  tables: [
    {
      schema: 'public',
      name: 'users',
      kind: 'table',
      columns: [
        column('email'),
        column('salary', 'numeric'),
        column('id', 'int8'),
        column('created_at', 'timestamptz'),
      ],
      primaryKey: ['id'],
      uniqueKeys: [],
      foreignKeys: [],
    },
  ],
};

describe('columnOrder config', () => {
  it('keeps visible columns and warns about the rest', () => {
    const config = wardenConfigSchema.parse({
      defaults: { newColumns: 'hidden' },
      tables: {
        users: {
          columnOrder: ['salary', 'nickname', 'email', 'created_at'],
          columns: { email: {}, salary: {}, id: {} },
        },
      },
    });
    const { schema, warnings } = resolveSchema(model, config);
    expect(schema.entities[0]?.columnOrder).toEqual(['salary', 'email']);
    expect(warnings).toEqual([
      { path: 'tables.users.columnOrder.1', message: 'column "nickname" does not exist' },
      { path: 'tables.users.columnOrder.3', message: 'column "created_at" is not visible' },
    ]);
  });

  it('is absent when nothing usable is listed', () => {
    const config = wardenConfigSchema.parse({ tables: { users: { columnOrder: ['nope'] } } });
    expect(resolveSchema(model, config).schema.entities[0]).not.toHaveProperty('columnOrder');
  });

  it('leaves out columns the user cannot read', () => {
    const config = wardenConfigSchema.parse({
      roles: { hr: {} },
      tables: {
        users: {
          columnOrder: ['salary', 'email'],
          columns: { salary: { readableBy: ['hr'] } },
        },
      },
    });
    const { schema } = resolveSchema(model, config);
    const { policy } = resolvePolicy(schema, config);
    const viewer = schemaFor(schema, policy, []).entities[0]!;
    expect(viewer.columnOrder).toEqual(['email']);
    expect(gridColumnOrder(viewer)).not.toContain('salary');
    expect(schemaFor(schema, policy, ['hr']).entities[0]?.columnOrder).toEqual(['salary', 'email']);

    const onlyHidden = wardenConfigSchema.parse({
      roles: { hr: {} },
      tables: {
        users: { columnOrder: ['salary'], columns: { salary: { readableBy: ['hr'] } } },
      },
    });
    const resolved = resolveSchema(model, onlyHidden).schema;
    const narrowed = schemaFor(resolved, resolvePolicy(resolved, onlyHidden).policy, [])
      .entities[0];
    expect(narrowed).not.toHaveProperty('columnOrder');
  });
});
