import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  entityFor,
  humanize,
  resolveSchema,
  type Column,
  type SchemaModel,
  type Table,
} from '../src/index.js';

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
const id = col('id', {
  dataType: 'int8',
  formattedType: 'bigint',
  identity: 'always',
  hasDefault: true,
});
const table = (name: string, columns: Column[], overrides: Partial<Table> = {}): Table => ({
  schema: 'public',
  name,
  kind: 'table',
  columns,
  primaryKey: ['id'],
  uniqueKeys: [],
  foreignKeys: [],
  ...overrides,
});

const model: SchemaModel = {
  enums: [{ schema: 'public', name: 'user_role', values: ['member', 'admin'] }],
  tables: [
    table('companies', [id, col('name'), col('domain', { nullable: true })]),
    table(
      'users',
      [
        id,
        col('company_id', { dataType: 'int8', formattedType: 'bigint', nullable: true }),
        col('email'),
        col('role', {
          dataType: 'user_role',
          formattedType: 'user_role',
          enum: { schema: 'public', name: 'user_role' },
        }),
        col('password_hash'),
        col('created_at', { dataType: 'timestamptz', formattedType: 'timestamp with time zone' }),
      ],
      {
        uniqueKeys: [['email']],
        foreignKeys: [
          {
            name: 'users_company_id_fkey',
            columns: ['company_id'],
            references: { schema: 'public', name: 'companies', columns: ['id'] },
          },
        ],
      },
    ),
    table('audit_events', [id, col('payload', { dataType: 'jsonb', formattedType: 'jsonb' })], {
      schema: 'ops',
    }),
  ],
};

const resolve = (config: unknown = {}) => resolveSchema(model, wardenConfigSchema.parse(config));
const entity = (config: unknown, key: string) => {
  const e = resolve(config).schema.entities.find((x) => x.key === key);
  if (!e) throw new Error(`entity ${key} not exposed`);
  return e;
};
const fieldNames = (config: unknown, key: string) => entity(config, key).fields.map((f) => f.name);

describe('resolveSchema defaults', () => {
  it('exposes every table and column with derived labels and display fields', () => {
    const { schema, warnings } = resolve({ schemas: ['public', 'ops'] });
    expect(warnings).toEqual([]);
    expect(schema.entities.map((e) => [e.key, e.label, e.displayField])).toEqual([
      ['companies', 'Companies', 'name'],
      ['users', 'Users', 'email'],
      ['ops.audit_events', 'Audit events', 'id'],
    ]);
    expect(fieldNames({}, 'users')).toEqual([
      'id',
      'company_id',
      'email',
      'role',
      'password_hash',
      'created_at',
    ]);
  });

  it('makes identity-always and generated columns read-only, and attaches enum values', () => {
    const users = entity({}, 'users');
    expect(users.fields.find((f) => f.name === 'id')?.readOnly).toBe(true);
    expect(users.fields.find((f) => f.name === 'email')?.readOnly).toBe(false);
    expect(users.fields.find((f) => f.name === 'role')?.enumValues).toEqual(['member', 'admin']);
  });

  it('searches visible, non-array text columns by default', () => {
    expect(entity({}, 'users').searchable).toEqual(['email', 'password_hash']);
    expect(entity({}, 'companies').searchable).toEqual(['name', 'domain']);
  });

  it('builds belongsTo and hasMany relations', () => {
    expect(entity({}, 'users').relations).toEqual([
      {
        kind: 'belongsTo',
        name: 'users_company_id_fkey',
        entity: 'companies',
        columns: ['company_id'],
        targetColumns: ['id'],
      },
    ]);
    expect(entity({}, 'companies').relations).toEqual([
      {
        kind: 'hasMany',
        name: 'users_company_id_fkey',
        entity: 'users',
        columns: ['id'],
        targetColumns: ['company_id'],
      },
    ]);
  });
});

describe('resolveSchema with config', () => {
  it('never includes hidden tables or columns anywhere in the output', () => {
    const { schema } = resolve({
      tables: {
        companies: { hidden: true },
        users: { columns: { password_hash: { hidden: true } } },
      },
    });
    const json = JSON.stringify(schema);
    expect(json).not.toContain('password_hash');
    expect(json).not.toContain('companies');
    // The FK now points at a hidden table, so the relation is dropped too.
    expect(schema.entities.find((e) => e.key === 'users')?.relations).toEqual([]);
  });

  it('lists the writes that require a reason, in canonical order', () => {
    const config = { tables: { users: { requireReason: ['delete', 'create', 'delete'] } } };
    expect(entity(config, 'users').requireReason).toEqual(['create', 'delete']);
    expect(entity(config, 'companies')).not.toHaveProperty('requireReason');
    expect(entity({ tables: { users: { requireReason: [] } } }, 'users')).not.toHaveProperty(
      'requireReason',
    );
  });

  it('drops relations whose FK columns are hidden', () => {
    const config = { tables: { users: { columns: { company_id: { hidden: true } } } } };
    expect(entity(config, 'users').relations).toEqual([]);
    expect(entity(config, 'companies').relations).toEqual([]);
  });

  it('applies labels, read-only, display field, sort and search', () => {
    const users = entity(
      {
        tables: {
          users: {
            label: 'People',
            displayField: 'email',
            defaultSort: { column: 'created_at', direction: 'desc' },
            searchable: ['email'],
            columns: { created_at: { readOnly: true, label: 'Joined' } },
          },
        },
      },
      'users',
    );
    expect(users).toMatchObject({
      label: 'People',
      displayField: 'email',
      defaultSort: { column: 'created_at', direction: 'desc' },
      searchable: ['email'],
    });
    expect(users.fields.find((f) => f.name === 'created_at')).toMatchObject({
      label: 'Joined',
      readOnly: true,
    });
  });

  it('exposes only configured tables when expose is none', () => {
    const { schema } = resolve({ defaults: { expose: 'none' }, tables: { users: {} } });
    expect(schema.entities.map((e) => e.key)).toEqual(['users']);
  });

  it('treats unmentioned columns per newColumns, but always keeps primary keys', () => {
    const hidden = {
      defaults: { newColumns: 'hidden' },
      tables: { users: { columns: { email: {} } } },
    };
    expect(fieldNames(hidden, 'users')).toEqual(['id', 'email']);

    const readOnly = entity(
      { defaults: { newColumns: 'readOnly' }, tables: { users: { columns: { email: {} } } } },
      'users',
    );
    expect(readOnly.fields.filter((f) => !f.readOnly).map((f) => f.name)).toEqual(['email']);
  });

  it('matches qualified and unqualified keys against the default schema', () => {
    expect(
      fieldNames({ tables: { 'public.users': { columns: { email: { hidden: true } } } } }, 'users'),
    ).not.toContain('email');
    const ops = resolve({
      schemas: ['public', 'ops'],
      tables: { 'ops.audit_events': { label: 'Audit' } },
    });
    expect(ops.schema.entities.find((e) => e.key === 'ops.audit_events')?.label).toBe('Audit');
  });

  it('fails when two exposed tables would share an entity key', () => {
    const colliding: SchemaModel = {
      enums: [],
      tables: [table('a.b', [id]), table('b', [id], { schema: 'a' })],
    };
    const resolveColliding = (config: unknown) =>
      resolveSchema(
        colliding,
        wardenConfigSchema.parse({ schemas: ['public', 'a'], ...(config as object) }),
      );
    expect(() => resolveColliding({})).toThrow(
      'tables "public"."a.b" and "a"."b" both have the key "a.b"',
    );
    // Only one is exposed, so there is no collision.
    expect(resolveColliding({ tables: { 'a.b': { hidden: true } } }).schema.entities).toEqual([
      expect.objectContaining({ schema: 'public', name: 'a.b', key: 'a.b' }),
    ]);
    expect(
      resolveColliding({ defaults: { expose: 'none' }, tables: { 'a.b': {} } }).schema.entities,
    ).toEqual([expect.objectContaining({ schema: 'a', name: 'b', key: 'a.b' })]);
  });

  it('uses the first schema as the default for keys', () => {
    const { schema } = resolve({ schemas: ['ops', 'public'] });
    expect(schema.entities.map((e) => e.key)).toEqual([
      'public.companies',
      'public.users',
      'audit_events',
    ]);
  });
});

describe('resolveSchema warnings', () => {
  it('warns about config that does not match the database instead of failing', () => {
    const { schema, warnings } = resolve({
      tables: {
        orders: {},
        users: {
          displayField: 'nickname',
          defaultSort: { column: 'deleted_at' },
          searchable: ['email', 'bio'],
          columns: {
            id: { hidden: true },
            nickname: { label: 'Nick' },
            password_hash: { hidden: true },
          },
        },
      },
    });

    expect(warnings).toEqual([
      { path: 'tables.orders', message: 'table "public.orders" does not exist' },
      { path: 'tables.users.columns.nickname', message: 'column "nickname" does not exist' },
      { path: 'tables.users.columns.id', message: 'primary key columns cannot be hidden' },
      { path: 'tables.users.displayField', message: 'column "nickname" does not exist' },
      { path: 'tables.users.searchable.1', message: 'column "bio" does not exist' },
      { path: 'tables.users.defaultSort.column', message: 'column "deleted_at" does not exist' },
    ]);

    const users = schema.entities.find((e) => e.key === 'users');
    expect(users).toMatchObject({ label: 'Users', displayField: 'email', searchable: ['email'] });
    expect(users?.defaultSort).toBeUndefined();
    expect(users?.fields.map((f) => f.name)).toContain('id');
  });

  it('warns when config references a column hidden by newColumns', () => {
    const { warnings } = resolve({
      defaults: { newColumns: 'hidden' },
      tables: { users: { defaultSort: { column: 'created_at' }, columns: { email: {} } } },
    });
    expect(warnings).toEqual([
      { path: 'tables.users.defaultSort.column', message: 'column "created_at" is not visible' },
    ]);
  });
});

describe('humanize', () => {
  it.each([
    ['full_name', 'Full name'],
    ['orderItems', 'Order items'],
    ['created_at', 'Created at'],
    ['ID', 'Id'],
    ['users', 'Users'],
  ])('%s → %s', (input, expected) => {
    expect(humanize(input)).toBe(expected);
  });
});

describe('primary keys on update', () => {
  const keyed: SchemaModel = {
    enums: [],
    tables: [
      table(
        'memberships',
        [
          col('org', { hasDefault: true }),
          col('member'),
          col('since', { dataType: 'date', formattedType: 'date', nullable: true }),
        ],
        { primaryKey: ['org', 'member'] },
      ),
      table('events', [id, col('name')]),
    ],
  };
  const resolveKeyed = (config: unknown, key: string) => {
    const e = resolveSchema(keyed, wardenConfigSchema.parse(config)).schema.entities.find(
      (x) => x.key === key,
    );
    if (!e) throw new Error(`entity ${key} not exposed`);
    return e;
  };

  it('makes writable primary key columns create-only', () => {
    const memberships = resolveKeyed({}, 'memberships');
    expect(memberships.fields.map((f) => [f.name, f.readOnly, f.createOnly])).toEqual([
      ['org', false, true],
      ['member', false, true],
      ['since', false, undefined],
    ]);
    // Already read-only, so there's nothing to restrict.
    expect(resolveKeyed({}, 'events').fields[0]).not.toHaveProperty('createOnly');

    expect(entityFor(memberships, 'create')).toBe(memberships);
    expect(entityFor(memberships, 'update').fields.map((f) => [f.name, f.readOnly])).toEqual([
      ['org', true],
      ['member', true],
      ['since', false],
    ]);
  });

  it('lets updates change primary keys only when the table opts in', () => {
    const memberships = resolveKeyed(
      { tables: { memberships: { updatablePrimaryKey: true } } },
      'memberships',
    );
    expect(memberships.fields.some((f) => f.createOnly)).toBe(false);
    expect(entityFor(memberships, 'update')).toBe(memberships);
    // Configured read-only still wins.
    const locked = resolveKeyed(
      {
        tables: {
          memberships: { updatablePrimaryKey: true, columns: { org: { readOnly: true } } },
        },
      },
      'memberships',
    );
    expect(locked.fields.find((f) => f.name === 'org')?.readOnly).toBe(true);
  });
});
