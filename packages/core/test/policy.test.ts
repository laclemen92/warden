import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  isAllowed,
  resolvePolicy,
  resolveSchema,
  type Column,
  type SchemaModel,
  type Table,
} from '../src/index.js';

const id: Column = {
  name: 'id',
  dataType: 'int8',
  formattedType: 'bigint',
  isArray: false,
  nullable: false,
  hasDefault: true,
  generated: false,
};
const table = (name: string, schema = 'public'): Table => ({
  schema,
  name,
  kind: 'table',
  columns: [id],
  primaryKey: ['id'],
  uniqueKeys: [],
  foreignKeys: [],
});

const model: SchemaModel = {
  enums: [],
  tables: [table('users'), table('companies'), table('orders'), table('invoices', 'billing')],
};

const resolve = (config: unknown) => {
  const parsed = wardenConfigSchema.parse({
    schemas: ['public', 'billing'],
    ...(config as object),
  });
  return resolvePolicy(resolveSchema(model, parsed).schema, parsed);
};
const policyFor = (config: unknown) => resolve(config).policy;

const ISSUE_EXAMPLE = {
  roles: {
    viewer: { grants: { '*': ['read'] } },
    ops: {
      grants: {
        users: ['read', 'update'],
        companies: ['read', 'create', 'update'],
      },
    },
  },
  tables: { orders: { deny: ['create', 'delete'] } },
};

describe('policy defaults', () => {
  const policy = policyFor({});

  it('allows reading every exposed entity, even with no roles', () => {
    for (const entity of ['users', 'companies', 'orders', 'billing.invoices']) {
      expect(isAllowed(policy, [], entity, 'read')).toBe(true);
    }
  });

  it('denies create, update and delete without a grant', () => {
    expect(allowedActions(policy, ['admin'], 'users')).toEqual(['read']);
    expect(allowedActions(policy, [], 'orders')).toEqual(['read']);
  });

  it('requires a read grant when defaults.read is granted', () => {
    const granted = policyFor({
      defaults: { read: 'granted' },
      roles: { support: { grants: { users: ['read'] } } },
    });
    expect(isAllowed(granted, [], 'users', 'read')).toBe(false);
    expect(isAllowed(granted, ['other'], 'users', 'read')).toBe(false);
    expect(isAllowed(granted, ['support'], 'users', 'read')).toBe(true);
    expect(isAllowed(granted, ['support'], 'companies', 'read')).toBe(false);
  });
});

describe('policy grants', () => {
  const policy = policyFor(ISSUE_EXAMPLE);

  it('applies per-table grants to that table only', () => {
    expect(allowedActions(policy, ['ops'], 'users')).toEqual(['read', 'update']);
    expect(allowedActions(policy, ['ops'], 'companies')).toEqual(['read', 'create', 'update']);
    expect(allowedActions(policy, ['ops'], 'billing.invoices')).toEqual(['read']);
  });

  it('applies `*` grants to every entity', () => {
    const policy = policyFor({ roles: { admin: { grants: { '*': ['update', 'delete'] } } } });
    for (const entity of ['users', 'companies', 'orders', 'billing.invoices']) {
      expect(allowedActions(policy, ['admin'], entity)).toEqual(['read', 'update', 'delete']);
    }
  });

  it('combines grants across roles', () => {
    const policy = policyFor({
      roles: {
        a: { grants: { users: ['create'] } },
        b: { grants: { users: ['delete'], '*': ['update'] } },
      },
    });
    expect(allowedActions(policy, ['a'], 'users')).toEqual(['read', 'create']);
    expect(allowedActions(policy, ['a', 'b'], 'users')).toEqual([
      'read',
      'create',
      'update',
      'delete',
    ]);
  });

  it('grants nothing to unknown roles', () => {
    expect(allowedActions(policy, ['superuser'], 'users')).toEqual(['read']);
  });

  it('treats `table` and `schema.table` keys as the same entity', () => {
    const policy = policyFor({
      roles: {
        r: {
          grants: { users: ['create'], 'public.users': ['delete'], 'billing.invoices': ['update'] },
        },
      },
    });
    expect(allowedActions(policy, ['r'], 'users')).toEqual(['read', 'create', 'delete']);
    expect(allowedActions(policy, ['r'], 'billing.invoices')).toEqual(['read', 'update']);
  });

  it('only matches entity keys, not raw table names in other schemas', () => {
    const policy = policyFor({ roles: { r: { grants: { 'billing.invoices': ['update'] } } } });
    expect(isAllowed(policy, ['r'], 'invoices', 'update')).toBe(false);
    expect(isAllowed(policy, ['r'], 'invoices', 'read')).toBe(false);
  });
});

describe('policy deny', () => {
  it('beats every grant, including `*`', () => {
    const policy = policyFor({
      roles: {
        admin: { grants: { '*': ['read', 'create', 'update', 'delete'] } },
        ops: { grants: { orders: ['create', 'update', 'delete'] } },
      },
      tables: { orders: { deny: ['create', 'delete'] } },
    });
    expect(allowedActions(policy, ['admin', 'ops'], 'orders')).toEqual(['read', 'update']);
    expect(allowedActions(policy, ['admin'], 'users')).toEqual([
      'read',
      'create',
      'update',
      'delete',
    ]);
  });

  it('can deny read even when reading is allowed by default', () => {
    const policy = policyFor({
      roles: { viewer: { grants: { '*': ['read'] } } },
      tables: { 'public.orders': { deny: ['read'] } },
    });
    expect(isAllowed(policy, [], 'orders', 'read')).toBe(false);
    expect(isAllowed(policy, ['viewer'], 'orders', 'read')).toBe(false);
  });

  it('matches the issue example', () => {
    const policy = policyFor(ISSUE_EXAMPLE);
    expect(allowedActions(policy, ['viewer'], 'orders')).toEqual(['read']);
    expect(allowedActions(policy, ['viewer', 'ops'], 'companies')).toEqual([
      'read',
      'create',
      'update',
    ]);
  });
});

describe('policy for entities that are not exposed', () => {
  it('denies every action on hidden or nonexistent entities, whatever is granted', () => {
    const policy = policyFor({
      defaults: { expose: 'none' },
      roles: { admin: { grants: { '*': ['read', 'create', 'update', 'delete'] } } },
      tables: { users: {}, companies: { hidden: true } },
    });
    expect(allowedActions(policy, ['admin'], 'users')).toEqual([
      'read',
      'create',
      'update',
      'delete',
    ]);
    for (const entity of ['companies', 'orders', 'billing.invoices', 'nope', '*', '']) {
      expect(allowedActions(policy, ['admin'], entity)).toEqual([]);
    }
  });

  it('warns about grants and denies naming tables that are not exposed', () => {
    const { warnings } = resolve({
      roles: { ops: { grants: { ghosts: ['read'], companies: ['update'], '*': ['read'] } } },
      tables: {
        'billing.missing': { deny: ['create'] },
        companies: { hidden: true, deny: ['delete'] },
      },
    });
    expect(warnings).toEqual([
      { path: 'roles.ops.grants.ghosts', message: 'table "public.ghosts" is not exposed' },
      { path: 'roles.ops.grants.companies', message: 'table "public.companies" is not exposed' },
      { path: 'tables.billing.missing.deny', message: 'table "billing.missing" is not exposed' },
    ]);
  });

  it('has no warnings for a config that matches the schema', () => {
    expect(resolve(ISSUE_EXAMPLE).warnings).toEqual([]);
  });
});
