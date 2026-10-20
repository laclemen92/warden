import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '../src/validation.js';
import { fieldSchema, validateRecord, type Entity, type Field } from '../src/index.js';

const field = (name: string, overrides: Partial<Field> = {}): Field => ({
  name,
  label: name,
  dataType: 'text',
  formattedType: 'text',
  isArray: false,
  nullable: false,
  hasDefault: false,
  readOnly: false,
  ...overrides,
});

const entity: Entity = {
  key: 'users',
  schema: 'public',
  name: 'users',
  kind: 'table',
  label: 'Users',
  primaryKey: ['id'],
  displayField: 'email',
  searchable: [],
  relations: [],
  fields: [
    field('id', { dataType: 'int8', hasDefault: true, readOnly: true }),
    field('email', { dataType: 'varchar', maxLength: 10 }),
    field('nickname', { nullable: true }),
    field('role', { dataType: 'user_role', hasDefault: true, enumValues: ['member', 'admin'] }),
    field('balance', { dataType: 'numeric', precision: 5, scale: 2, nullable: true }),
    field('metadata', { dataType: 'jsonb', hasDefault: true }),
    field('tags', { isArray: true, maxLength: 3, nullable: true }),
  ],
};

const errors = (input: unknown, mode: 'create' | 'update' = 'create') => {
  const result = validateRecord(entity, input, mode);
  return result.ok ? [] : result.errors;
};

describe('validateRecord', () => {
  it('accepts a valid create payload and returns its values', () => {
    const input = {
      email: 'a@b.co',
      nickname: null,
      role: 'admin',
      balance: '123.45',
      metadata: { nested: [1, 'two', null] },
      tags: ['abc', null],
    };
    expect(validateRecord(entity, input, 'create')).toEqual({ ok: true, values: input });
  });

  it('requires NOT NULL fields without a default on create only', () => {
    expect(errors({})).toEqual([{ field: 'email', message: 'is required' }]);
    expect(errors({}, 'update')).toEqual([]);
  });

  it('rejects null for NOT NULL fields, even those with defaults', () => {
    expect(errors({ email: null, role: null })).toEqual([
      { field: 'email', message: 'cannot be null' },
      { field: 'role', message: 'cannot be null' },
    ]);
  });

  it('rejects read-only fields', () => {
    expect(errors({ id: 1 }, 'update')).toEqual([{ field: 'id', message: 'is read-only' }]);
  });

  it('accepts create-only fields on create and rejects them on update', () => {
    const keyed: Entity = {
      ...entity,
      key: 'codes',
      primaryKey: ['code'],
      fields: [field('code', { createOnly: true }), field('note', { nullable: true })],
    };
    expect(validateRecord(keyed, {}, 'create')).toEqual({
      ok: false,
      errors: [{ field: 'code', message: 'is required' }],
    });
    expect(validateRecord(keyed, { code: 'a' }, 'create')).toEqual({
      ok: true,
      values: { code: 'a' },
    });
    expect(validateRecord(keyed, { code: 'b', note: 'x' }, 'update')).toEqual({
      ok: false,
      errors: [{ field: 'code', message: 'is read-only' }],
    });
    expect(validateRecord(keyed, { note: 'x' }, 'update')).toEqual({
      ok: true,
      values: { note: 'x' },
    });
  });

  it('rejects unknown fields like nonexistent ones', () => {
    // A hidden column is simply absent from the entity, so it gets the same message.
    expect(errors({ password_hash: 'x', nope: 1 }, 'update')).toEqual([
      { field: 'password_hash', message: 'unknown field "password_hash"' },
      { field: 'nope', message: 'unknown field "nope"' },
    ]);
  });

  it('rejects non-object input', () => {
    for (const input of [null, [], 'x', 1]) {
      expect(errors(input)).toEqual([{ message: 'expected an object of field values' }]);
    }
  });

  it('checks lengths, enums, precision, and array elements', () => {
    expect(
      errors({ email: 'abcdefghijk', role: 'owner', balance: 1000, tags: ['abcd', 1] }, 'update'),
    ).toEqual([
      { field: 'email', message: 'must be at most 10 characters' },
      { field: 'role', message: 'expected one of "member", "admin"' },
      { field: 'balance', message: 'must have at most 3 digits before the decimal point' },
      { field: 'tags', message: 'item 0: must be at most 3 characters' },
      { field: 'tags', message: 'item 1: expected a string' },
    ]);
  });
});

describe('fieldSchema', () => {
  const accepts = (f: Field, value: unknown) => fieldSchema(f).safeParse(value).success;

  it.each<[Partial<Field>, unknown, boolean]>([
    [{ dataType: 'int4' }, 2147483647, true],
    [{ dataType: 'int4' }, 2147483648, false],
    [{ dataType: 'int4' }, '12', true],
    [{ dataType: 'int4' }, '1.0', false],
    [{ dataType: 'int8' }, '9223372036854775807', true],
    [{ dataType: 'int8' }, 2 ** 60, false],
    [{ dataType: 'numeric' }, '1e400', true],
    [{ dataType: 'numeric', precision: 3, scale: 3 }, '0.999', true],
    [{ dataType: 'numeric', precision: 3, scale: 3 }, '1', false],
    [{ dataType: 'numeric', precision: 4, scale: 2 }, '0.000012e6', true],
    [{ dataType: 'numeric', precision: 4, scale: 2 }, '0.00012e6', false],
    [{ dataType: 'numeric' }, '1e200000', false],
    [{ dataType: 'float8' }, '1e308', true],
    [{ dataType: 'float8' }, '1e400', false],
    [{ dataType: 'float8' }, '1e-400', false],
    [{ dataType: 'float4' }, 1e38, true],
    [{ dataType: 'float4' }, 1e39, false],
    [{ dataType: 'float4' }, '1e39', false],
    [{ dataType: 'money' }, '12.34', true],
    [{ dataType: 'money' }, '1e3', false],
    [{ dataType: 'timestamptz' }, '2026-01-02T00:00:00+16:00', false],
    [{ dataType: 'float8' }, Number.NaN, false],
    [{ dataType: 'float8' }, 'NaN', false],
    [{ dataType: 'bool' }, 'true', false],
    [{ dataType: 'uuid' }, '4B9E8A1C-1F0E-4C1A-9D3E-0A1B2C3D4E5F', true],
    [{ dataType: 'timestamptz' }, '2026-01-02 03:04:05.123456+05:30', true],
    [{ dataType: 'date' }, '2026-01-02T00:00:00Z', false],
    [{ dataType: 'time' }, '2026-01-02', false],
    [{ dataType: 'jsonb' }, { a: [1, true] }, true],
    [{ dataType: 'jsonb' }, 'plain string', true],
    [{ dataType: 'text' }, 'a\u0000b', false],
    [{ dataType: 'bpchar', maxLength: 2 }, '😀😀', true],
    [{ dataType: 'inet' }, '10.0.0.1', true],
    [{ dataType: 'inet' }, 10, false],
    [{ isArray: true }, 'a', false],
    [{ isArray: true, dataType: 'role', enumValues: ['a'] }, ['a', null], true],
    [{ isArray: true, dataType: 'role', enumValues: ['a'] }, ['b'], false],
  ])('%j accepts %j: %s', (overrides, value, expected) => {
    expect(accepts(field('f', overrides), value)).toBe(expected);
  });

  it('limits how deeply JSON values nest, without overflowing the stack', () => {
    const nested = (depth: number, leaf: unknown = 1) => {
      let value = leaf;
      for (let i = 0; i < depth; i++) value = i % 2 ? { a: value } : [value];
      return value;
    };
    const json = field('f', { dataType: 'jsonb' });
    expect(accepts(json, nested(MAX_JSON_DEPTH))).toBe(true);
    expect(accepts(json, nested(MAX_JSON_DEPTH + 1))).toBe(false);
    // Deep enough that a recursive check would throw a RangeError.
    expect(accepts(json, nested(200_000))).toBe(false);
    expect(errors({ email: 'a@b.co', metadata: nested(200_000) })).toEqual([
      { field: 'metadata', message: `must be nested at most ${MAX_JSON_DEPTH} levels deep` },
    ]);
    const array = field('f', { dataType: 'jsonb', isArray: true });
    expect(accepts(array, [nested(MAX_JSON_DEPTH), null])).toBe(true);
    expect(accepts(array, [nested(MAX_JSON_DEPTH + 1)])).toBe(false);
  });

  it('accepts null only for nullable fields', () => {
    expect(accepts(field('f'), null)).toBe(false);
    expect(accepts(field('f', { nullable: true }), null)).toBe(true);
  });
});
