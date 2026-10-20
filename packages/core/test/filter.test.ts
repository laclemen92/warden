import { describe, expect, it } from 'vitest';
import {
  FILTER_LIMITS,
  fieldCategory,
  searchFilter,
  validateFilter,
  type Entity,
  type Field,
  type Filter,
  type Scalar,
} from '../src/index.js';

const field = (name: string, dataType: string, overrides: Partial<Field> = {}): Field => ({
  name,
  label: name,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  readOnly: false,
  ...overrides,
});

const users: Entity = {
  key: 'users',
  schema: 'public',
  name: 'users',
  kind: 'table',
  label: 'Users',
  primaryKey: ['id'],
  displayField: 'email',
  searchable: ['email', 'full_name', 'role'],
  relations: [],
  fields: [
    field('id', 'int8'),
    field('email', 'text'),
    field('full_name', 'varchar'),
    field('role', 'user_role', { enumValues: ['member', 'admin'] }),
    field('is_active', 'bool'),
    field('created_at', 'timestamptz'),
    field('external_id', 'uuid'),
    field('metadata', 'jsonb'),
    field('tags', 'text', { isArray: true }),
    field('location', 'point'),
  ],
};

const errorsFor = (input: unknown) => {
  const result = validateFilter(users, input);
  if (result.ok) throw new Error('expected filter to be invalid');
  return result.errors;
};
const valid = (input: Filter) =>
  expect(validateFilter(users, input)).toEqual({ ok: true, filter: input });

describe('validateFilter', () => {
  it('accepts well-typed conditions for every category', () => {
    valid({
      and: [
        { field: 'email', op: 'contains', value: 'example' },
        { field: 'id', op: 'between', value: ['10', 20] },
        { field: 'role', op: 'in', value: ['member', 'admin'] },
        { field: 'is_active', op: 'eq', value: true },
        { field: 'created_at', op: 'gte', value: '2026-01-01T00:00:00Z' },
        { field: 'external_id', op: 'eq', value: '0b6f0d4e-3c5a-4c8e-9f3b-1d2e3f4a5b6c' },
        { or: [{ field: 'metadata', op: 'isNull' }, { not: { field: 'tags', op: 'isNotNull' } }] },
      ],
    });
  });

  it('accepts big integers as numeric strings', () => {
    valid({ field: 'id', op: 'eq', value: '9223372036854775807' });
    valid({ field: 'id', op: 'lt', value: '-9223372036854775808' });
  });

  it('treats hidden and nonexistent fields the same', () => {
    expect(errorsFor({ field: 'password_hash', op: 'eq', value: 'x' })).toEqual([
      { path: 'field', message: 'unknown field "password_hash"' },
    ]);
  });

  it('rejects operators that do not fit the field type', () => {
    expect(
      errorsFor({
        and: [
          { field: 'id', op: 'contains', value: '1' },
          { field: 'is_active', op: 'gt', value: true },
          { field: 'role', op: 'startsWith', value: 'ad' },
          { field: 'metadata', op: 'eq', value: '{}' },
          { field: 'tags', op: 'eq', value: 'a' },
          { field: 'location', op: 'eq', value: '(1,2)' },
        ],
      }).map((e) => e.path),
    ).toEqual(['and.0.op', 'and.1.op', 'and.2.op', 'and.3.op', 'and.4.op', 'and.5.op']);
  });

  it('rejects values that do not parse as the field type', () => {
    expect(
      errorsFor({
        and: [
          { field: 'id', op: 'eq', value: '1 or 1=1' },
          { field: 'id', op: 'in', value: [1, 'two', 3] },
          { field: 'email', op: 'eq', value: 5 },
          { field: 'is_active', op: 'eq', value: 'true' },
          { field: 'created_at', op: 'lt', value: 'yesterday' },
          { field: 'external_id', op: 'eq', value: 'not-a-uuid' },
          { field: 'role', op: 'eq', value: 'superuser' },
        ],
      }),
    ).toEqual([
      { path: 'and.0.value', message: 'expected an integer' },
      { path: 'and.1.value.1', message: 'expected an integer' },
      { path: 'and.2.value', message: 'expected a string' },
      { path: 'and.3.value', message: 'expected a boolean' },
      { path: 'and.4.value', message: 'expected an ISO 8601 date-time' },
      { path: 'and.5.value', message: 'expected a UUID' },
      { path: 'and.6.value', message: 'expected one of "member", "admin"' },
    ]);
  });

  describe('rejects values the column cannot hold', () => {
    const typed: Entity = {
      ...users,
      fields: [
        field('i2', 'int2'),
        field('i8', 'int8'),
        field('f4', 'float4'),
        field('f8', 'float8'),
        field('n', 'numeric', { precision: 5, scale: 2 }),
        field('m', 'money'),
        field('d', 'date'),
        field('t', 'time'),
        field('ts', 'timestamptz'),
        field('s', 'varchar', { maxLength: 3 }),
      ],
    };
    const check = (name: string, value: Scalar) => {
      const result = validateFilter(typed, { field: name, op: 'eq', value });
      return result.ok || result.errors[0]!.message;
    };

    it.each<[string, Scalar, true | string]>([
      ['i2', '32767', true],
      ['i2', 32768, 'must be between -32768 and 32767'],
      ['i8', '1.5', 'expected an integer'],
      ['i8', 1.5, 'expected an integer'],
      ['i8', '9223372036854775808', 'must be between -9223372036854775808 and 9223372036854775807'],
      ['f4', '3.4028235e38', true],
      ['f4', '1e39', 'is out of range for real'],
      ['f4', '1e-46', 'is out of range for real'],
      ['f4', '0e-99', true],
      ['f8', '1e308', true],
      ['f8', '5e-324', true],
      ['f8', '1e400', 'is out of range for double precision'],
      ['f8', '-1e-400', 'is out of range for double precision'],
      ['f8', '-0.000', true],
      // Typmods don't constrain comparisons, only writes.
      ['n', '123456.789', true],
      ['n', '1e131071', true],
      ['n', '1e131072', 'is out of range for numeric'],
      ['n', '1e-16383', true],
      ['n', '1e-16384', 'is out of range for numeric'],
      ['n', '0e-20000', 'is out of range for numeric'],
      ['n', '0e1073741823', true],
      ['n', '0e1073741824', 'is out of range for numeric'],
      ['m', '-92233720368547758.08', true],
      ['m', '92233720368547758.0749', true],
      ['m', '92233720368547758.075', 'is out of range for money'],
      ['m', '-92233720368547758.085', 'is out of range for money'],
      ['m', '.5', true],
      ['m', '1e5', 'expected an amount without an exponent'],
      ['d', '2024-02-29', true],
      ['d', '2026-02-30', 'is not a valid date/time'],
      ['d', '0000-01-01', 'is not a valid date/time'],
      ['d', '2026-12-31', true],
      ['d', '2026-01-01T00:00', 'expected a date (YYYY-MM-DD)'],
      ['t', '24:00:00', true],
      ['t', '24:00:01', 'is not a valid date/time'],
      ['t', '2026-01-01', 'expected a time (HH:MM:SS)'],
      ['ts', '2026-01-01T23:59:60', true],
      ['ts', '2026-01-01T23:59:60.5', 'is not a valid date/time'],
      ['ts', '2026-01-01T00:00+15:59', true],
      ['ts', '2026-01-01T00:00+16:00', 'is not a valid date/time'],
      ['ts', '2026-01-01T00:00-1560', 'is not a valid date/time'],
      ['ts', '13:00', 'expected an ISO 8601 date-time'],
      ['s', 'longer than three', true],
      ['s', 'a\u0000b', 'cannot contain NUL characters'],
    ])('%s = %j: %s', (name, value, expected) => {
      expect(check(name, value)).toBe(expected);
    });

    it('checks every value of a list and text operators too', () => {
      expect(
        errorsFor({
          and: [
            { field: 'id', op: 'in', value: ['1', '2.5', '3'] },
            { field: 'email', op: 'contains', value: '\u0000' },
          ],
        }),
      ).toEqual([
        { path: 'and.0.value.1', message: 'expected an integer' },
        { path: 'and.1.value', message: 'cannot contain NUL characters' },
      ]);
    });
  });

  it('rejects malformed structure', () => {
    for (const input of [
      null,
      'email = 1',
      [],
      {},
      { and: [] },
      { field: 'email', op: 'like', value: '%' },
      { field: 'email', op: 'eq' },
      { field: 'email', op: 'eq', value: null },
      { field: 'email', op: 'eq', value: { $ne: 1 } },
      { field: 'email', op: 'in', value: [] },
      { field: 'email', op: 'between', value: ['a'] },
      { field: 'email', op: 'isNull', value: 1 },
      { field: 'email', op: 'eq', value: 'a', extra: true },
      { and: [{ field: 'email', op: 'isNull' }], or: [] },
    ]) {
      expect(validateFilter(users, input).ok, JSON.stringify(input)).toBe(false);
    }
  });

  it('rejects SQL injection attempts in field names', () => {
    for (const name of [
      'email; drop table users; --',
      'email" = \'x\' or "1"="1',
      '"email"',
      'users.email',
      'email)--',
    ]) {
      expect(errorsFor({ field: name, op: 'isNull' })).toEqual([
        { path: 'field', message: `unknown field "${name}"` },
      ]);
    }
  });

  it('allows SQL-looking text values on text fields (they are parameterized)', () => {
    valid({ field: 'email', op: 'eq', value: "'; drop table users; --" });
  });

  it('enforces size limits', () => {
    let deep: Filter = { field: 'email', op: 'isNull' };
    for (let i = 0; i < FILTER_LIMITS.maxDepth; i++) deep = { not: deep };
    expect(errorsFor(deep)[0]?.message).toMatch(/nest at most/);

    const wide = { or: Array.from({ length: 101 }, () => ({ field: 'email', op: 'isNull' })) };
    expect(errorsFor(wide)).toEqual([
      { path: '', message: 'filters can have at most 100 conditions' },
    ]);

    expect(validateFilter(users, { field: 'id', op: 'in', value: Array(501).fill(1) }).ok).toBe(
      false,
    );
    expect(validateFilter(users, { field: 'email', op: 'eq', value: 'x'.repeat(1001) }).ok).toBe(
      false,
    );
  });
});

describe('fieldCategory', () => {
  it('maps types, enums and arrays', () => {
    const category = (name: string) => fieldCategory(users.fields.find((f) => f.name === name)!);
    expect(
      [
        'id',
        'email',
        'role',
        'is_active',
        'created_at',
        'external_id',
        'metadata',
        'tags',
        'location',
      ].map(category),
    ).toEqual(['number', 'text', 'enum', 'boolean', 'temporal', 'uuid', 'json', 'other', 'other']);
  });
});

describe('searchFilter', () => {
  it('ORs contains across searchable text fields only', () => {
    expect(searchFilter(users, '  ada ')).toEqual({
      or: [
        { field: 'email', op: 'contains', value: 'ada' },
        { field: 'full_name', op: 'contains', value: 'ada' },
      ],
    });
  });

  it('returns undefined for blank queries', () => {
    expect(searchFilter(users, '   ')).toBeUndefined();
    expect(searchFilter(users, ' \u0000 ')).toBeUndefined();
  });

  it('drops NUL characters, which Postgres rejects in patterns', () => {
    expect(validateFilter(users, searchFilter(users, 'a\u0000da'))).toMatchObject({
      ok: true,
      filter: { or: [{ value: 'ada' }, { value: 'ada' }] },
    });
  });

  it('produces filters that validate', () => {
    const filter = searchFilter(users, 'x')!;
    expect(validateFilter(users, filter).ok).toBe(true);
  });
});
