import { validateFilter, type Condition } from '@wardenhq/core';
import { describe, expect, it } from 'vitest';
import {
  conditionToDraft,
  conditionsToFilter,
  describeCondition,
  draftToCondition,
  filterToConditions,
  fromInputValue,
  newDraft,
  operatorsFor,
  toInputValue,
  withOperator,
  type DraftCondition,
} from '../src/lib/filters';
import { fieldOf, orders } from './fixtures';

const draft = (field: string, op: DraftCondition['op'], values: string[]): DraftCondition => ({
  id: 'x',
  field,
  op,
  values,
});

const toCondition = (d: DraftCondition) => {
  const result = draftToCondition(orders, d);
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.condition;
};

describe('draftToCondition', () => {
  it.each<[DraftCondition, Condition]>([
    [draft('status', 'eq', ['paid']), { field: 'status', op: 'eq', value: 'paid' }],
    [
      draft('status', 'in', ['paid', 'shipped', 'paid']),
      { field: 'status', op: 'in', value: ['paid', 'shipped'] },
    ],
    [draft('is_gift', 'eq', ['false']), { field: 'is_gift', op: 'eq', value: false }],
    // Numbers stay strings to keep numeric precision.
    [
      draft('total', 'gte', [' 12345678901234567.25 ']),
      { field: 'total', op: 'gte', value: '12345678901234567.25' },
    ],
    [draft('id', 'in', ['1', ' 2', '', '3 ']), { field: 'id', op: 'in', value: ['1', '2', '3'] }],
    [draft('notes', 'contains', [' gift ']), { field: 'notes', op: 'contains', value: ' gift ' }],
    [
      draft('ship_by', 'between', ['2026-01-01', '2026-01-31']),
      { field: 'ship_by', op: 'between', value: ['2026-01-01', '2026-01-31'] },
    ],
    [
      draft('ship_by', 'between', ['2026-01-01', '']),
      { field: 'ship_by', op: 'gte', value: '2026-01-01' },
    ],
    [
      draft('ship_by', 'between', ['', '2026-01-31']),
      { field: 'ship_by', op: 'lte', value: '2026-01-31' },
    ],
    [draft('metadata', 'isNull', []), { field: 'metadata', op: 'isNull' }],
  ])('%j → %j', (input, expected) => {
    const condition = toCondition(input);
    expect(condition).toEqual(expected);
    // Whatever the builder produces must pass the server's validation.
    expect(validateFilter(orders, condition)).toEqual({ ok: true, filter: expected });
  });

  it.each([
    draft('status', 'eq', []),
    draft('status', 'in', []),
    draft('total', 'eq', ['  ']),
    draft('ship_by', 'between', ['', '']),
    draft('notes', 'contains', ['']),
  ])('treats %j as not filled in yet', (input) => {
    expect(draftToCondition(orders, input)).toEqual({ status: 'empty' });
  });

  it.each([
    [draft('total', 'eq', ['12abc']), 'Total: expected a number'],
    [draft('id', 'in', ['1', 'two']), 'Id: expected an integer'],
    [draft('ship_by', 'between', ['yesterday', '']), 'Ship by: expected a date (YYYY-MM-DD)'],
    [draft('status', 'eq', ['lost']), 'Status: expected one of "pending", "paid", "shipped"'],
    [draft('secret', 'eq', ['x']), 'Unknown field'],
  ])('rejects %j', (input, message) => {
    expect(draftToCondition(orders, input)).toEqual({ status: 'invalid', message });
  });
});

describe('operators', () => {
  it('offer only what the field type supports', () => {
    expect(operatorsFor(fieldOf(orders, 'is_gift'))).toEqual(['eq', 'neq', 'isNull', 'isNotNull']);
    expect(operatorsFor(fieldOf(orders, 'metadata'))).toEqual(['isNull', 'isNotNull']);
    expect(operatorsFor(fieldOf(orders, 'notes'))).toContain('contains');
    expect(operatorsFor(fieldOf(orders, 'status'))).not.toContain('contains');
  });

  it('defaults to a sensible operator per type', () => {
    expect(newDraft(fieldOf(orders, 'notes')).op).toBe('contains');
    expect(newDraft(fieldOf(orders, 'placed_at')).op).toBe('between');
    expect(newDraft(fieldOf(orders, 'status')).op).toBe('eq');
    expect(newDraft(fieldOf(orders, 'metadata')).op).toBe('isNotNull');
  });

  it('keeps the value only when the new operator takes the same shape', () => {
    const d = draft('total', 'eq', ['5']);
    expect(withOperator(d, 'gt').values).toEqual(['5']);
    expect(withOperator(d, 'between').values).toEqual([]);
    expect(withOperator(d, 'isNull').values).toEqual([]);
  });
});

describe('filterToConditions', () => {
  const a: Condition = { field: 'status', op: 'eq', value: 'paid' };
  const b: Condition = { field: 'total', op: 'between', value: ['1', '2'] };

  it('reads the shapes the builder writes', () => {
    expect(filterToConditions(undefined)).toEqual([]);
    expect(filterToConditions(JSON.stringify(conditionsToFilter([a])))).toEqual([a]);
    expect(filterToConditions(JSON.stringify(conditionsToFilter([a, b])))).toEqual([a, b]);
    expect(conditionsToFilter([])).toBeUndefined();
  });

  it.each(['not json', '{"or":[]}', JSON.stringify({ and: [a, { not: a }] }), '[]', 'null'])(
    'leaves %s to the server as a custom filter',
    (raw) => {
      expect(filterToConditions(raw)).toBeUndefined();
    },
  );

  it('round-trips through drafts', () => {
    const drafts = [a, b].map(conditionToDraft);
    expect(drafts.map(toCondition)).toEqual([a, b]);
  });
});

describe('describeCondition', () => {
  it('uses field labels and type-specific wording', () => {
    expect(
      describeCondition(orders, { field: 'status', op: 'in', value: ['paid', 'shipped'] }),
    ).toBe('Status is any of paid, shipped');
    expect(describeCondition(orders, { field: 'ship_by', op: 'lt', value: '2026-01-01' })).toBe(
      'Ship by before 2026-01-01',
    );
    expect(describeCondition(orders, { field: 'notes', op: 'isNull' })).toBe('Notes is empty');
  });
});

describe('timestamptz inputs', () => {
  const placedAt = fieldOf(orders, 'placed_at');
  const shipBy = fieldOf(orders, 'ship_by');

  it('adds the browser offset so the database reads local time', () => {
    const value = fromInputValue(placedAt, '2026-03-04T05:06');
    expect(value).toMatch(/^2026-03-04T05:06:00[+-]\d{2}:\d{2}$/);
    expect(new Date(value).getTime()).toBe(new Date('2026-03-04T05:06').getTime());
    expect(toInputValue(placedAt, value)).toBe('2026-03-04T05:06');
    expect(validateFilter(orders, { field: 'placed_at', op: 'gt', value }).ok).toBe(true);
  });

  it('leaves other types and empty values alone', () => {
    expect(fromInputValue(shipBy, '2026-03-04')).toBe('2026-03-04');
    expect(fromInputValue(placedAt, '')).toBe('');
    expect(toInputValue(shipBy, '2026-03-04')).toBe('2026-03-04');
  });
});
