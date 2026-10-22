import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import { resolveActor, type Column, type SchemaModel, type Table } from '../src/index.js';

const col = (name: string, overrides: Partial<Column> = {}): Column => ({
  name,
  dataType: 'text',
  formattedType: 'text',
  isArray: false,
  nullable: false,
  hasDefault: false,
  generated: false,
  ...overrides,
});
const table = (schema: string, name: string, columns: Column[]): Table => ({
  schema,
  name,
  kind: 'table',
  columns,
  primaryKey: ['id'],
  uniqueKeys: [],
  foreignKeys: [],
});

const model: SchemaModel = {
  enums: [],
  tables: [
    table('public', 'users', [
      col('id', { dataType: 'uuid', formattedType: 'uuid' }),
      col('email', { dataType: 'citext', formattedType: 'citext' }),
      col('emails', { isArray: true, formattedType: 'text[]' }),
      col('age', { dataType: 'int4', formattedType: 'integer' }),
    ]),
    table('auth', 'staff', [col('id'), col('mail', { dataType: 'varchar' })]),
  ],
};

const resolve = (actor: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  resolveActor(
    model,
    wardenConfigSchema.parse({
      schemas: ['public', 'auth'],
      ...extra,
      ...(actor ? { actor } : {}),
    }),
  );

describe('resolveActor', () => {
  it('is off without actor config', () => {
    expect(resolve(undefined)).toEqual({ required: false, warnings: [] });
  });

  it('maps a table, hidden or not, by its introspected names', () => {
    const actor = { table: 'users', matchColumn: 'email', idColumn: 'id' };
    const expected = {
      mapping: { schema: 'public', table: 'users', matchColumn: 'email', idColumn: 'id' },
      required: false,
      warnings: [],
    };
    expect(resolve(actor)).toEqual(expected);
    expect(resolve(actor, { tables: { users: { hidden: true } } })).toEqual(expected);
    expect(resolve({ ...actor, required: true }).required).toBe(true);
    expect(resolve({ table: 'auth.staff', matchColumn: 'mail', idColumn: 'id' }).mapping).toEqual({
      schema: 'auth',
      table: 'staff',
      matchColumn: 'mail',
      idColumn: 'id',
    });
  });

  it.each([
    [{ table: 'people' }, 'actor.table', 'table "public.people" does not exist'],
    [{ matchColumn: 'nope' }, 'actor.matchColumn', 'column "nope" does not exist'],
    [{ matchColumn: 'age' }, 'actor.matchColumn', 'column "age" is not a text column'],
    [{ matchColumn: 'emails' }, 'actor.matchColumn', 'column "emails" is not a text column'],
    [{ idColumn: 'nope' }, 'actor.idColumn', 'column "nope" does not exist'],
  ])('warns and maps nothing for a mismatch: %o', (override, path, message) => {
    for (const required of [false, true]) {
      const result = resolve({
        table: 'users',
        matchColumn: 'email',
        idColumn: 'id',
        required,
        ...override,
      });
      // `required` stays, so sign-in fails closed.
      expect(result).toEqual({ required, warnings: [{ path, message }] });
    }
  });
});
