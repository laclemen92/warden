import { describe, expect, it } from 'vitest';
import {
  FILTER_LIMITS,
  fieldCategory,
  searchFilter,
  validateFilter,
  type Entity,
  type Field,
  type Filter,
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

  it('accepts big integers and decimals as numeric strings', () => {
    valid({ field: 'id', op: 'eq', value: '9223372036854775807' });
    valid({ field: 'id', op: 'lt', value: '-12.50' });
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
      { path: 'and.0.value', message: 'expected a number' },
      { path: 'and.1.value.1', message: 'expected a number' },
      { path: 'and.2.value', message: 'expected a string' },
      { path: 'and.3.value', message: 'expected a boolean' },
      { path: 'and.4.value', message: 'expected an ISO 8601 date/time' },
      { path: 'and.5.value', message: 'expected a UUID' },
      { path: 'and.6.value', message: 'expected one of "member", "admin"' },
    ]);
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
  });

  it('produces filters that validate', () => {
    const filter = searchFilter(users, 'x')!;
    expect(validateFilter(users, filter).ok).toBe(true);
  });
});
