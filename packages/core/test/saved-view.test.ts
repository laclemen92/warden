import { describe, expect, it } from 'vitest';
import { validateViewState, viewName, type Entity, type Field } from '../src/index.js';

const field = (name: string, dataType: string): Field => ({
  name,
  label: name,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  readOnly: false,
});

const users: Entity = {
  key: 'users',
  schema: 'public',
  name: 'users',
  kind: 'table',
  label: 'Users',
  primaryKey: ['id'],
  displayField: 'email',
  searchable: ['email'],
  relations: [],
  fields: [field('id', 'int8'), field('email', 'text'), field('metadata', 'jsonb')],
};

describe('validateViewState', () => {
  it('accepts a full state and drops empty parts', () => {
    const filter = { field: 'email', op: 'contains', value: '@example.com' };
    expect(
      validateViewState(users, { filter, q: '  ada ', sort: '-email', columns: ['email', 'id'] }),
    ).toEqual({ ok: true, state: { filter, q: 'ada', sort: '-email', columns: ['email', 'id'] } });
    expect(validateViewState(users, { q: ' ', sort: '' })).toEqual({ ok: true, state: {} });
  });

  it('rejects fields the entity does not have, wherever they appear', () => {
    const result = validateViewState(users, {
      filter: { and: [{ field: 'password_hash', op: 'isNull' }] },
      sort: 'password_hash',
      columns: ['email', 'password_hash'],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        { path: 'filter.and.0.field', message: 'unknown field "password_hash"' },
        { path: 'sort', message: 'unknown field "password_hash"' },
        { path: 'columns.1', message: 'unknown field "password_hash"' },
      ],
    });
  });

  it('rejects unsortable sorts, duplicate columns, and malformed filters', () => {
    expect(validateViewState(users, { sort: 'metadata' })).toMatchObject({
      ok: false,
      errors: [{ path: 'sort', message: 'cannot sort by "metadata"' }],
    });
    expect(validateViewState(users, { columns: ['id', 'id'] })).toMatchObject({
      ok: false,
      errors: [{ path: 'columns.1' }],
    });
    expect(
      validateViewState(users, { filter: { field: 'id', op: 'like', value: 1 } }),
    ).toMatchObject({ ok: false, errors: [{ path: expect.stringMatching(/^filter/) }] });
  });

  it('rejects unknown keys, wrong types, and an empty column list', () => {
    for (const input of [
      null,
      'sort=id',
      { pageSize: 50 },
      { q: 1 },
      { columns: [] },
      { columns: 'id' },
      { sort: 'x'.repeat(1001) },
    ]) {
      expect(validateViewState(users, input).ok, JSON.stringify(input)).toBe(false);
    }
  });
});

describe('viewName', () => {
  it('trims and enforces a length', () => {
    expect(viewName('  Active  ')).toBe('Active');
    expect(viewName('   ')).toBeUndefined();
    expect(viewName('x'.repeat(101))).toBeUndefined();
  });
});
