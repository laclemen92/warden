import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  resolvePolicy,
  resolveSchema,
  schemaFor,
  validateFilter,
  validateRecord,
  type Column,
  type EffectiveSchema,
  type Entity,
  type SchemaModel,
} from '../src/index.js';

const column = (name: string, dataType = 'text', extra: Partial<Column> = {}): Column => ({
  name,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  generated: false,
  ...extra,
});

const model: SchemaModel = {
  enums: [],
  tables: [
    {
      schema: 'public',
      name: 'companies',
      kind: 'table',
      columns: [column('id', 'int8', { nullable: false }), column('name')],
      primaryKey: ['id'],
      uniqueKeys: [],
      foreignKeys: [],
    },
    {
      schema: 'public',
      name: 'users',
      kind: 'table',
      columns: [
        column('id', 'int8', { nullable: false }),
        column('company_id', 'int8'),
        column('email'),
        column('full_name'),
        column('role'),
        column('salary', 'numeric'),
      ],
      primaryKey: ['id'],
      uniqueKeys: [],
      foreignKeys: [
        {
          name: 'users_company_id_fkey',
          columns: ['company_id'],
          references: { schema: 'public', name: 'companies', columns: ['id'] },
        },
      ],
    },
  ],
};

const ROLES = { admin: {}, hr: {}, ops: {} };

function resolve(tables: unknown) {
  const config = wardenConfigSchema.parse({ roles: ROLES, tables });
  const { schema } = resolveSchema(model, config);
  return { schema, ...resolvePolicy(schema, config) };
}

const entity = (schema: EffectiveSchema, key: string): Entity =>
  schema.entities.find((e) => e.key === key)!;
const fieldNames = (e: Entity) => e.fields.map((f) => f.name);

const RULES = {
  users: {
    displayField: 'email',
    defaultSort: { column: 'email' },
    searchable: ['email', 'full_name'],
    columns: {
      email: { readableBy: ['admin', 'hr'] },
      role: { writableBy: ['admin'] },
      salary: { readableBy: ['hr', 'admin'], writableBy: ['hr'] },
      company_id: { readableBy: ['admin'] },
    },
  },
};

describe('schemaFor', () => {
  const { schema, policy, warnings } = resolve(RULES);

  it('records rules without warnings', () => {
    expect(warnings).toEqual([]);
    expect(policy.fields.get('users')?.get('role')).toEqual({ writableBy: new Set(['admin']) });
  });

  it('removes unreadable fields and marks unwritable ones read-only', () => {
    const users = entity(schemaFor(schema, policy, ['ops']), 'users');
    expect(fieldNames(users)).toEqual(['id', 'full_name', 'role']);
    expect(users.fields.find((f) => f.name === 'role')?.readOnly).toBe(true);
    expect(users.fields.find((f) => f.name === 'full_name')?.readOnly).toBe(false);

    const hr = entity(schemaFor(schema, policy, ['hr']), 'users');
    expect(fieldNames(hr)).toEqual(['id', 'email', 'full_name', 'role', 'salary']);
    expect(hr.fields.find((f) => f.name === 'salary')?.readOnly).toBe(false);
    expect(hr.fields.find((f) => f.name === 'role')?.readOnly).toBe(true);
  });

  it('combines roles: any role that is allowed is enough', () => {
    const users = entity(schemaFor(schema, policy, ['ops', 'admin']), 'users');
    expect(fieldNames(users)).toEqual(fieldNames(entity(schema, 'users')));
    expect(users.fields.find((f) => f.name === 'role')?.readOnly).toBe(false);
    // admin may read salary but only hr may write it.
    expect(users.fields.find((f) => f.name === 'salary')?.readOnly).toBe(true);
  });

  it('returns the same schema when nothing is restricted for the roles', () => {
    const unrestricted = resolve({});
    expect(schemaFor(unrestricted.schema, unrestricted.policy, [])).toBe(unrestricted.schema);
  });

  it('drops search, sort, and display settings that name removed fields', () => {
    const users = entity(schemaFor(schema, policy, ['ops']), 'users');
    expect(users.searchable).toEqual(['full_name']);
    expect(users.defaultSort).toBeUndefined();
    expect(users.displayField).toBe('id');
    const admin = entity(schemaFor(schema, policy, ['admin']), 'users');
    expect(admin).toMatchObject({ displayField: 'email', defaultSort: { column: 'email' } });
  });

  it('drops relations through unreadable key columns, on both sides', () => {
    const narrowed = schemaFor(schema, policy, ['ops']);
    expect(entity(narrowed, 'users').relations).toEqual([]);
    expect(entity(narrowed, 'companies').relations).toEqual([]);
    expect(entity(schemaFor(schema, policy, ['admin']), 'companies').relations).toHaveLength(1);
  });

  it('makes removed fields fail validation exactly like nonexistent ones', () => {
    const users = entity(schemaFor(schema, policy, ['ops']), 'users');
    const filterOn = (field: string) =>
      validateFilter(users, { field, op: 'eq', value: 'x' }) as {
        ok: false;
        errors: { message: string }[];
      };
    expect(filterOn('email').errors[0]?.message).toBe(
      filterOn('nope').errors[0]?.message.replace('nope', 'email'),
    );
    expect(validateRecord(users, { email: 'x' }, 'update')).toEqual({
      ok: false,
      errors: [{ field: 'email', message: 'unknown field "email"' }],
    });
    expect(validateRecord(users, { role: 'x' }, 'update')).toEqual({
      ok: false,
      errors: [{ field: 'role', message: 'is read-only' }],
    });
    expect(validateRecord(users, { full_name: 'x' }, 'update').ok).toBe(true);
  });

  it('never exposes the rules themselves', () => {
    expect(JSON.stringify(schemaFor(schema, policy, ['ops']))).not.toMatch(/readableBy|admin|hr/);
  });
});

describe('field rules in resolvePolicy', () => {
  it('keeps primary keys readable, with a warning', () => {
    const { policy, warnings } = resolve({
      users: { columns: { id: { readableBy: ['admin'], writableBy: ['admin'] } } },
    });
    expect(warnings).toEqual([
      {
        path: 'tables.users.columns.id.readableBy',
        message: 'primary key columns are readable by everyone who can read the table',
      },
    ]);
    expect(policy.fields.get('users')?.get('id')).toEqual({ writableBy: new Set(['admin']) });
  });

  it('ignores rules on columns that are hidden or missing, and on hidden tables', () => {
    const { policy } = resolve({
      users: { columns: { nope: { readableBy: ['admin'] } } },
      companies: { hidden: true, columns: { name: { readableBy: ['admin'] } } },
    });
    expect(policy.fields.size).toBe(0);
  });
});

describe('schemaFor and entity actions', () => {
  function resolveWith(config: unknown) {
    const parsed = wardenConfigSchema.parse(config);
    const { schema } = resolveSchema(model, parsed);
    return { schema, ...resolvePolicy(schema, parsed) };
  }
  const keys = (schema: EffectiveSchema) => schema.entities.map((e) => e.key);

  it('removes entities the roles may not read under defaults.read: granted', () => {
    const { schema, policy } = resolveWith({
      defaults: { read: 'granted' },
      roles: { support: { grants: { users: ['read'] } } },
    });
    const narrowed = schemaFor(schema, policy, ['support']);
    expect(keys(narrowed)).toEqual(['users']);
    // The relation to the removed companies table goes with it.
    expect(entity(narrowed, 'users').relations).toEqual([]);
    expect(entity(narrowed, 'users')).toEqual({ ...entity(schema, 'users'), relations: [] });
  });

  it('removes entities whose read is denied, even with defaults.read: all and a * grant', () => {
    const { schema, policy } = resolveWith({
      roles: { support: { grants: { '*': ['read'] } } },
      tables: { users: { deny: ['read'] } },
    });
    for (const roles of [[], ['support']]) {
      const narrowed = schemaFor(schema, policy, roles);
      expect(keys(narrowed)).toEqual(['companies']);
      expect(entity(narrowed, 'companies').relations).toEqual([]);
    }
  });

  it('leaves users with no roles nothing under defaults.read: granted', () => {
    const { schema, policy } = resolveWith({
      defaults: { read: 'granted' },
      roles: { support: { grants: { '*': ['read'] } } },
    });
    expect(schemaFor(schema, policy, [])).toEqual({ entities: [] });
    expect(schemaFor(schema, policy, ['unknown'])).toEqual({ entities: [] });
  });

  it('keeps entities the roles may write but not read, with their relations', () => {
    const { schema, policy } = resolveWith({
      defaults: { read: 'granted' },
      roles: { intake: { grants: { users: ['create'], companies: ['read'] } } },
    });
    const narrowed = schemaFor(schema, policy, ['intake']);
    expect(keys(narrowed)).toEqual(keys(schema));
    expect(entity(narrowed, 'users').relations).toHaveLength(1);
  });

  it('applies field rules to the entities that remain', () => {
    const { schema, policy } = resolveWith({
      defaults: { read: 'granted' },
      roles: { ops: { grants: { users: ['read'] } }, admin: { grants: {} } },
      tables: { users: { columns: { salary: { readableBy: ['admin'] } } } },
    });
    const narrowed = schemaFor(schema, policy, ['ops']);
    expect(keys(narrowed)).toEqual(['users']);
    expect(fieldNames(entity(narrowed, 'users'))).not.toContain('salary');
  });
});
