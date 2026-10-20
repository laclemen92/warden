import type { Entity, Field } from '@wardenhq/core';
import { describe, expect, it } from 'vitest';
import {
  formFields,
  formValues,
  fromDraft,
  initialDrafts,
  pickerRelations,
  toDraft,
  widgetFor,
} from '../src/lib/form-fields';

function field(name: string, dataType: string, extra: Partial<Field> = {}): Field {
  return {
    name,
    label: name,
    dataType,
    formattedType: dataType,
    isArray: false,
    nullable: true,
    hasDefault: false,
    readOnly: false,
    ...extra,
  };
}

const products: Entity = {
  key: 'products',
  schema: 'public',
  name: 'products',
  kind: 'table',
  label: 'Products',
  primaryKey: ['id'],
  displayField: 'name',
  searchable: ['name'],
  fields: [
    field('id', 'int8', { nullable: false, hasDefault: true, readOnly: true }),
    field('name', 'varchar', { nullable: false, maxLength: 10 }),
    field('description', 'text'),
    field('price', 'numeric', { nullable: false, precision: 6, scale: 2 }),
    field('active', 'bool', { nullable: false, hasDefault: true }),
    field('status', 'product_status', { enumValues: ['draft', 'live'] }),
    field('released_on', 'date'),
    field('updated_at', 'timestamptz', { nullable: false, hasDefault: true }),
    field('attrs', 'jsonb'),
    field('tags', 'text', { isArray: true }),
    field('category_id', 'int4'),
  ],
  relations: [
    {
      kind: 'belongsTo',
      name: 'products_category_id_fkey',
      entity: 'categories',
      columns: ['category_id'],
      targetColumns: ['id'],
    },
  ],
};

const f = (name: string) => products.fields.find((x) => x.name === name)!;

describe('widgetFor', () => {
  it.each([
    ['name', 'text'],
    ['description', 'textarea'],
    ['price', 'number'],
    ['active', 'boolean'],
    ['status', 'enum'],
    ['released_on', 'date'],
    ['updated_at', 'datetime'],
    ['attrs', 'json'],
    ['tags', 'json'],
    ['category_id', 'number'],
  ])('%s → %s', (name, widget) => {
    expect(widgetFor(f(name))).toBe(widget);
  });

  it('uses a native picker only for values it can show', () => {
    expect(widgetFor(f('released_on'), '2026-03-01')).toBe('date');
    expect(widgetFor(f('released_on'), 'infinity')).toBe('text');
    expect(widgetFor(f('released_on'), '0044-03-15 BC')).toBe('text');
    expect(widgetFor(field('t', 'time'), '12:30:00.123456')).toBe('time');
    expect(widgetFor(field('t', 'timetz'))).toBe('text');
    expect(widgetFor(field('t', 'timestamp'), '2026-03-01 12:30:00')).toBe('datetime');
    expect(widgetFor(f('updated_at'), '2026-03-01 12:30:00+00')).toBe('datetime');
    expect(widgetFor(f('updated_at'), '-infinity')).toBe('text');
  });
});

describe('drafts', () => {
  it('starts nulls empty, JSON pretty-printed, and timestamps in picker format', () => {
    expect(toDraft(f('description'), 'textarea', null)).toBe('');
    expect(toDraft(f('attrs'), 'json', { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(toDraft(f('tags'), 'json', ['x'])).toBe('[\n  "x"\n]');
    expect(toDraft(field('t', 'timestamp'), 'datetime', '2026-03-01 12:30:00.123456')).toBe(
      '2026-03-01T12:30:00.123',
    );
    expect(toDraft(field('t', 'time'), 'time', '12:30:00.123456')).toBe('12:30:00.123');
    expect(toDraft(f('price'), 'number', '12.50')).toBe('12.50');
    expect(toDraft(f('active'), 'boolean', false)).toBe('false');
  });

  it('round-trips a timestamptz through local time to the same instant', () => {
    const draft = toDraft(f('updated_at'), 'datetime', '2026-03-01 12:30:05.5+05:30');
    expect(draft).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.500$/);
    const back = fromDraft(f('updated_at'), 'datetime', draft, 'update');
    expect(back).toEqual({ value: '2026-03-01T07:00:05.500Z' });
    // Postgres' short offsets, too.
    const utc = toDraft(f('updated_at'), 'datetime', '2026-03-01 12:30:00+00');
    expect(fromDraft(f('updated_at'), 'datetime', utc, 'update')).toEqual({
      value: '2026-03-01T12:30:00.000Z',
    });
  });

  it('turns a blank draft into the default, null, or a missing value', () => {
    expect(fromDraft(f('active'), 'boolean', '', 'create')).toEqual({ omit: true });
    expect(fromDraft(f('description'), 'textarea', '', 'create')).toEqual({ value: null });
    expect(fromDraft(f('name'), 'text', '', 'create')).toEqual({ error: 'is required' });
    expect(fromDraft(f('price'), 'number', '  ', 'update')).toEqual({ error: 'is required' });
    // Whitespace is text, not blank.
    expect(fromDraft(f('description'), 'textarea', ' ', 'create')).toEqual({ value: ' ' });
  });

  it('converts by widget', () => {
    expect(fromDraft(f('price'), 'number', ' 9.99 ', 'create')).toEqual({ value: '9.99' });
    expect(fromDraft(f('active'), 'boolean', 'true', 'create')).toEqual({ value: true });
    expect(fromDraft(f('attrs'), 'json', '{"a": [1]}', 'create')).toEqual({ value: { a: [1] } });
    expect(fromDraft(f('attrs'), 'json', '{a: 1}', 'create')).toEqual({
      error: 'is not valid JSON',
    });
  });
});

describe('formFields', () => {
  it('leaves read-only fields out of a create form and shows them when editing', () => {
    expect(formFields(products, 'create').map((x) => x.field.name)).not.toContain('id');
    expect(formFields(products, 'update').map((x) => x.field.name)).toContain('id');
  });

  it('starts a required checkbox unchecked on create', () => {
    const entity = { ...products, fields: [field('ok', 'bool', { nullable: false })] };
    expect(initialDrafts(formFields(entity, 'create'))).toEqual({ ok: 'false' });
  });
});

describe('formValues', () => {
  const fields = formFields(products, 'create');
  const drafts = (overrides: Record<string, string>) => ({
    ...initialDrafts(fields),
    ...overrides,
  });

  it('sends every field with a value on create, leaving defaults to the database', () => {
    const result = formValues(
      products,
      fields,
      drafts({ name: 'Lamp', price: '19.99', status: 'live', tags: '["a"]', category_id: '3' }),
      'create',
    );
    expect(result).toEqual({
      ok: true,
      values: {
        name: 'Lamp',
        description: null,
        price: '19.99',
        status: 'live',
        released_on: null,
        attrs: null,
        tags: ['a'],
        category_id: '3',
      },
    });
  });

  it('reports missing and invalid values with the server’s messages', () => {
    const result = formValues(
      products,
      fields,
      drafts({ name: 'A very long name', price: '12345.6', attrs: '{', tags: '[1]' }),
      'create',
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        name: ['must be at most 10 characters'],
        price: ['must have at most 4 digits before the decimal point'],
        attrs: ['is not valid JSON'],
        tags: ['item 0: expected a string'],
      },
    });
    expect(formValues(products, fields, drafts({}), 'create')).toMatchObject({
      ok: false,
      errors: { name: ['is required'], price: ['is required'] },
    });
  });

  it('sends only changed fields on update, never read-only ones', () => {
    const record = {
      id: '1',
      name: 'Lamp',
      description: null,
      price: '19.99',
      active: true,
      status: 'live',
      released_on: '2026-03-01',
      updated_at: '2026-03-01 12:30:00.123456+00',
      attrs: { a: 1 },
      tags: ['x'],
      category_id: 3,
    };
    const editFields = formFields(products, 'update', record);
    const initial = initialDrafts(editFields, record);
    expect(formValues(products, editFields, initial, 'update', initial)).toEqual({
      ok: true,
      values: {},
    });
    const changed = { ...initial, id: '2', description: 'Bright', status: '', active: 'false' };
    expect(formValues(products, editFields, changed, 'update', initial)).toEqual({
      ok: true,
      values: { description: 'Bright', status: null, active: false },
    });
  });
});

describe('pickerRelations', () => {
  const composite: Entity = {
    ...products,
    fields: [field('a', 'int4'), field('b', 'int4'), field('c', 'int4', { readOnly: true })],
    relations: [
      {
        kind: 'belongsTo',
        name: 'ab',
        entity: 't',
        columns: ['a', 'b'],
        targetColumns: ['x', 'y'],
      },
      { kind: 'belongsTo', name: 'b', entity: 'u', columns: ['b'], targetColumns: ['z'] },
      { kind: 'belongsTo', name: 'c', entity: 'v', columns: ['c'], targetColumns: ['z'] },
      { kind: 'hasMany', name: 'back', entity: 'w', columns: ['a'], targetColumns: ['q'] },
    ],
  };

  it('puts one picker at the first column of each writable foreign key', () => {
    const pickers = pickerRelations(composite);
    expect([...pickers.keys()]).toEqual(['a']);
    expect(pickers.get('a')?.name).toBe('ab');
  });
});
