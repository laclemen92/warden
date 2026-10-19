import { describe, expect, it } from 'vitest';
import { relationFilter, type Relation } from '../src/index.js';

const belongsTo: Relation = {
  kind: 'belongsTo',
  name: 'orders_user_id_fkey',
  entity: 'users',
  columns: ['user_id'],
  targetColumns: ['id'],
};

describe('relationFilter', () => {
  it('selects the parent row of a belongsTo relation', () => {
    expect(relationFilter(belongsTo, { id: '7', user_id: '42' })).toEqual({
      field: 'id',
      op: 'eq',
      value: '42',
    });
  });

  it('selects the child rows of a hasMany relation', () => {
    const hasMany: Relation = {
      kind: 'hasMany',
      name: 'orders_user_id_fkey',
      entity: 'orders',
      columns: ['id'],
      targetColumns: ['user_id'],
    };
    expect(relationFilter(hasMany, { id: '42' })).toEqual({
      field: 'user_id',
      op: 'eq',
      value: '42',
    });
  });

  it('matches composite keys positionally', () => {
    const composite: Relation = {
      kind: 'belongsTo',
      name: 'lines_invoice_fkey',
      entity: 'invoices',
      columns: ['invoice_company', 'invoice_number'],
      targetColumns: ['company_id', 'number'],
    };
    expect(relationFilter(composite, { invoice_company: '1', invoice_number: 9 })).toEqual({
      and: [
        { field: 'company_id', op: 'eq', value: '1' },
        { field: 'number', op: 'eq', value: 9 },
      ],
    });
  });

  it('returns null when a key value is null, missing, or not a scalar', () => {
    expect(relationFilter(belongsTo, { user_id: null })).toBeNull();
    expect(relationFilter(belongsTo, {})).toBeNull();
    expect(relationFilter(belongsTo, { user_id: { id: 1 } })).toBeNull();
  });
});
