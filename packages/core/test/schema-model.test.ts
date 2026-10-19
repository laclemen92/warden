import { describe, expect, it } from 'vitest';
import { getTable, type SchemaModel } from '../src/index.js';

const model: SchemaModel = {
  enums: [],
  tables: [
    {
      schema: 'public',
      name: 'users',
      kind: 'table',
      columns: [],
      primaryKey: ['id'],
      uniqueKeys: [],
      foreignKeys: [],
    },
    {
      schema: 'billing',
      name: 'users',
      kind: 'table',
      columns: [],
      primaryKey: ['id'],
      uniqueKeys: [],
      foreignKeys: [],
    },
  ],
};

describe('getTable', () => {
  it('defaults to the public schema', () => {
    expect(getTable(model, 'users')?.schema).toBe('public');
  });

  it('finds tables in other schemas', () => {
    expect(getTable(model, 'users', 'billing')?.schema).toBe('billing');
  });

  it('returns undefined for unknown tables', () => {
    expect(getTable(model, 'missing')).toBeUndefined();
  });
});
