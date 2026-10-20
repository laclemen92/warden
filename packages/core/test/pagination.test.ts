import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  decodeRecordId,
  encodeCursor,
  encodeRecordId,
  resolveSort,
  type Entity,
  type Field,
} from '../src/index.js';

const field = (name: string, dataType: string, overrides: Partial<Field> = {}): Field => ({
  name,
  label: name,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: false,
  hasDefault: false,
  readOnly: false,
  ...overrides,
});

const entity = (primaryKey: string[], extra: Partial<Entity> = {}): Entity => ({
  key: 'invoices',
  schema: 'public',
  name: 'invoices',
  kind: 'table',
  label: 'Invoices',
  primaryKey,
  displayField: 'number',
  searchable: [],
  relations: [],
  fields: [
    field('company_id', 'int8'),
    field('number', 'int4'),
    field('active', 'bool'),
    field('issued_at', 'timestamptz', { nullable: true }),
    field('meta', 'jsonb'),
    field('code', 'text'),
  ],
  ...extra,
});

describe('resolveSort', () => {
  const invoices = entity(['company_id', 'number']);

  it('parses directions and appends the primary key as a tiebreak', () => {
    expect(resolveSort(invoices, '-issued_at, number')).toEqual({
      ok: true,
      sort: [
        { field: 'issued_at', direction: 'desc' },
        { field: 'number', direction: 'asc' },
        { field: 'company_id', direction: 'asc' },
      ],
    });
  });

  it('falls back to the default sort, then the primary key', () => {
    expect(resolveSort(invoices).ok && resolveSort(invoices)).toMatchObject({
      sort: [
        { field: 'company_id', direction: 'asc' },
        { field: 'number', direction: 'asc' },
      ],
    });
    const withDefault = entity(['number'], {
      defaultSort: { column: 'issued_at', direction: 'desc' },
    });
    expect(resolveSort(withDefault, '')).toMatchObject({
      sort: [
        { field: 'issued_at', direction: 'desc' },
        { field: 'number', direction: 'asc' },
      ],
    });
  });

  it.each([
    ['secret', 'unknown field "secret"'],
    ['meta', 'cannot sort by "meta"'],
    ['number,-number', '"number" appears more than once in sort'],
    ['a,b,c,d,e,f', 'sort can have at most 5 fields'],
  ])('rejects %s', (input, message) => {
    expect(resolveSort(invoices, input)).toEqual({ ok: false, message });
  });
});

describe('record ids', () => {
  it('uses the raw value for single-column keys', () => {
    const e = entity(['number']);
    expect(encodeRecordId(e, { number: 42 })).toBe('42');
    expect(decodeRecordId(e, '42')).toEqual({
      ok: true,
      filter: { field: 'number', op: 'eq', value: '42' },
    });
  });

  it('round-trips composite keys', () => {
    const e = entity(['company_id', 'number']);
    const id = encodeRecordId(e, { company_id: '7', number: 3 })!;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRecordId(e, id)).toEqual({
      ok: true,
      filter: {
        and: [
          { field: 'company_id', op: 'eq', value: '7' },
          { field: 'number', op: 'eq', value: 3 },
        ],
      },
    });
  });

  it('coerces boolean keys from path strings', () => {
    expect(decodeRecordId(entity(['active']), 'true')).toMatchObject({
      ok: true,
      filter: { value: true },
    });
  });

  it('returns null ids when there is no key or a key value is null', () => {
    expect(encodeRecordId(entity([]), { number: 1 })).toBeNull();
    expect(encodeRecordId(entity(['number']), { number: null })).toBeNull();
  });

  it.each(['abc', '1.5.5', ''])('rejects malformed single ids: %j', (id) => {
    expect(decodeRecordId(entity(['number']), id).ok).toBe(false);
  });

  // Each would otherwise reach Postgres and fail there (22P02, 22003, 22008, 22021).
  it.each<[string, string]>([
    ['number', '1.5'],
    ['number', '1e3'],
    ['number', '2147483648'],
    ['company_id', '9223372036854775808'],
    ['issued_at', '2026-02-30'],
    ['issued_at', '2026-01-01 25:00'],
    ['code', 'a\u0000b'],
  ])('rejects %s ids the column cannot hold: %j', (key, id) => {
    expect(decodeRecordId(entity([key]), id)).toEqual({
      ok: false,
      message: 'malformed record id',
    });
  });

  it('rejects composite ids whose values the columns cannot hold', () => {
    const e = entity(['company_id', 'number']);
    expect(decodeRecordId(e, btoa(JSON.stringify(['7', 1.5]))).ok).toBe(false);
    expect(decodeRecordId(e, btoa(JSON.stringify(['7', 2 ** 31]))).ok).toBe(false);
  });

  it('rejects malformed composite ids', () => {
    const e = entity(['company_id', 'number']);
    for (const id of ['%%%', 'bm90IGpzb24', btoa('["1"]'), btoa('{"a":1}'), btoa('[1,{"x":1}]')]) {
      expect(decodeRecordId(e, id).ok, id).toBe(false);
    }
  });
});

describe('cursors', () => {
  const e = entity(['number']);
  const sort = [
    { field: 'issued_at', direction: 'desc' as const },
    { field: 'number', direction: 'asc' as const },
  ];

  it('round-trips sort values, including nulls', () => {
    const cursor = encodeCursor(sort, { issued_at: null, number: 9, active: true });
    expect(decodeCursor(e, sort, cursor)).toEqual({ ok: true, values: [null, 9] });
  });

  it('is bound to the sort it was created with', () => {
    const cursor = encodeCursor(sort, { issued_at: '2026-01-01 00:00:00+00', number: 1 });
    expect(decodeCursor(e, [{ field: 'number', direction: 'asc' }], cursor)).toEqual({
      ok: false,
      message: 'cursor does not match the current sort',
    });
  });

  it('rejects tampered or malformed cursors', () => {
    const forge = (v: unknown) => btoa(JSON.stringify({ s: '-issued_at,number', v }));
    for (const cursor of [
      '!!',
      btoa('nope'),
      forge(['yesterday', 1]),
      forge([null]),
      forge([null, { x: 1 }]),
      // Values of the right shape that the columns can't hold.
      forge([null, '1.5']),
      forge([null, '2147483648']),
      forge(['2026-02-30', 1]),
      forge(['2026-01-01 00:00:00+16', 1]),
    ]) {
      expect(decodeCursor(e, sort, cursor)).toMatchObject({ ok: false });
    }
  });

  it('refuses to encode values that cannot round-trip', () => {
    expect(() => encodeCursor(sort, { issued_at: new Date(), number: 1 })).toThrow(/cannot encode/);
  });
});
