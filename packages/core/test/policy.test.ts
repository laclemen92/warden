import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  deleteCascadeWarnings,
  isAllowed,
  resolvePolicy,
  resolveSchema,
  type Column,
  type ForeignKey,
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
    const policy = policyFor({ roles: { admin: { grants: { '*': ['create', 'update'] } } } });
    for (const entity of ['users', 'companies', 'orders', 'billing.invoices']) {
      expect(allowedActions(policy, ['admin'], entity)).toEqual(['read', 'create', 'update']);
    }
  });

  it('combines grants across roles', () => {
    const policy = policyFor({
      roles: {
        a: { grants: { users: ['create'] } },
        b: { grants: { users: ['delete'], '*': ['update'] } },
      },
      tables: { users: { allowDelete: true } },
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
          grants: { 'public.users': ['create', 'delete'], 'billing.invoices': ['update'] },
        },
      },
      tables: { users: { allowDelete: true } },
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
        admin: { grants: { '*': ['read', 'create', 'update'], users: ['delete'] } },
        ops: { grants: { orders: ['create', 'update', 'delete'] } },
      },
      tables: {
        users: { allowDelete: true },
        orders: { deny: ['create', 'delete'], allowDelete: true },
      },
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

describe('export', () => {
  it('needs its own grant, even when reading is allowed by default', () => {
    const policy = policyFor({ roles: { analyst: { grants: { users: ['export'] } } } });
    expect(isAllowed(policy, [], 'users', 'export')).toBe(false);
    expect(allowedActions(policy, ['analyst'], 'users')).toEqual(['read', 'export']);
    expect(allowedActions(policy, ['analyst'], 'companies')).toEqual(['read']);
  });

  it('also needs read', () => {
    const granted = policyFor({
      defaults: { read: 'granted' },
      roles: { exporter: { grants: { '*': ['export'] } }, reader: { grants: { users: ['read'] } } },
    });
    expect(isAllowed(granted, ['exporter'], 'users', 'export')).toBe(false);
    expect(isAllowed(granted, ['exporter', 'reader'], 'users', 'export')).toBe(true);

    const denied = policyFor({
      roles: { admin: { grants: { '*': ['read', 'export'] } } },
      tables: { users: { deny: ['read'] }, orders: { deny: ['export'] } },
    });
    expect(isAllowed(denied, ['admin'], 'users', 'export')).toBe(false);
    expect(isAllowed(denied, ['admin'], 'orders', 'export')).toBe(false);
    expect(isAllowed(denied, ['admin'], 'companies', 'export')).toBe(true);
  });
});

describe('policy for entities that are not exposed', () => {
  it('denies every action on hidden or nonexistent entities, whatever is granted', () => {
    const policy = policyFor({
      defaults: { expose: 'none' },
      roles: { admin: { grants: { '*': ['read', 'create', 'update'], users: ['delete'] } } },
      tables: { users: { allowDelete: true }, companies: { hidden: true, allowDelete: true } },
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

describe('hard delete', () => {
  const ENTITIES = ['users', 'companies', 'orders', 'billing.invoices'];

  it('is off everywhere by default, whatever roles grant', () => {
    const policy = policyFor({
      roles: {
        admin: { grants: { '*': ['read', 'create', 'update'], users: ['delete'] } },
        ops: { grants: { users: ['delete'], 'billing.invoices': ['delete'] } },
      },
    });
    for (const entity of ENTITIES) {
      expect(isAllowed(policy, ['admin', 'ops'], entity, 'delete')).toBe(false);
    }
    expect(allowedActions(policy, ['admin'], 'users')).toEqual(['read', 'create', 'update']);
  });

  it('opting one table in allows delete there and only there', () => {
    const policy = policyFor({
      roles: {
        ops: {
          grants: { users: ['delete'], companies: ['delete'], 'billing.invoices': ['delete'] },
        },
        viewer: { grants: { '*': ['read'] } },
      },
      tables: { users: { allowDelete: true } },
    });
    expect(isAllowed(policy, ['ops'], 'users', 'delete')).toBe(true);
    expect(isAllowed(policy, ['ops'], 'companies', 'delete')).toBe(false);
    expect(isAllowed(policy, ['ops'], 'billing.invoices', 'delete')).toBe(false);
    expect(isAllowed(policy, ['ops'], 'orders', 'delete')).toBe(false);
    // Opting in grants nothing by itself.
    expect(isAllowed(policy, ['viewer'], 'users', 'delete')).toBe(false);
    expect(isAllowed(policy, [], 'users', 'delete')).toBe(false);
  });

  it('matches allowDelete on `table` and `schema.table` keys', () => {
    const policy = policyFor({
      roles: { ops: { grants: { users: ['delete'], 'billing.invoices': ['delete'] } } },
      tables: { 'public.users': { allowDelete: true }, 'billing.invoices': { allowDelete: true } },
    });
    expect(isAllowed(policy, ['ops'], 'users', 'delete')).toBe(true);
    expect(isAllowed(policy, ['ops'], 'billing.invoices', 'delete')).toBe(true);
  });

  it('lets table deny beat the opt-in', () => {
    const optedIn = policyFor({
      roles: { ops: { grants: { users: ['delete'] } } },
      tables: { users: { allowDelete: true, deny: ['delete'] } },
    });
    expect(isAllowed(optedIn, ['ops'], 'users', 'delete')).toBe(false);
    const granted = policyFor({
      defaults: { delete: 'granted' },
      roles: { ops: { grants: { users: ['delete'] } } },
      tables: { users: { deny: ['delete'] } },
    });
    expect(isAllowed(granted, ['ops'], 'users', 'delete')).toBe(false);
  });

  it('honors named grants with defaults.delete: granted, unless the table opts out', () => {
    const policy = policyFor({
      defaults: { delete: 'granted' },
      roles: { ops: { grants: { users: ['delete'], companies: ['delete'] } } },
      tables: { companies: { allowDelete: false } },
    });
    expect(isAllowed(policy, ['ops'], 'users', 'delete')).toBe(true);
    expect(isAllowed(policy, ['ops'], 'companies', 'delete')).toBe(false);
    expect(isAllowed(policy, ['ops'], 'orders', 'delete')).toBe(false);
  });

  it('hides a table from a role whose only grant there is an ignored delete', () => {
    const policy = policyFor({
      defaults: { read: 'granted' },
      roles: { cleaner: { grants: { users: ['delete'] } } },
    });
    expect(allowedActions(policy, ['cleaner'], 'users')).toEqual([]);
  });

  it('warns about every delete grant it ignores, naming the key to add', () => {
    const { warnings } = resolve({
      roles: {
        admin: { grants: { '*': ['read'] } },
        ops: { grants: { users: ['update', 'delete'], 'billing.invoices': ['delete'] } },
        hr: { grants: { companies: ['delete'] } },
      },
      tables: {
        companies: { allowDelete: true },
        orders: { allowDelete: true, deny: ['delete'] },
      },
    });
    expect(warnings).toEqual([
      {
        path: 'roles.ops.grants.users',
        message:
          'delete is ignored: hard delete is off for "users"; ' +
          'set tables.users.allowDelete: true to allow it',
      },
      { path: 'tables.orders.allowDelete', message: 'has no effect: the table denies delete' },
      {
        path: 'roles.ops.grants.billing.invoices',
        message:
          'delete is ignored: hard delete is off for "billing.invoices"; ' +
          'set tables.billing.invoices.allowDelete: true to allow it',
      },
    ]);
  });
});

describe('deleteCascadeWarnings', () => {
  const fk = (
    name: string,
    references: string,
    onDelete?: 'cascade' | 'setNull' | 'setDefault',
  ): ForeignKey => ({
    name,
    columns: ['ref_id'],
    references: { schema: 'public', name: references, columns: ['id'] },
    ...(onDelete ? { onDelete } : {}),
  });
  const withFks = (t: Table, foreignKeys: ForeignKey[]): Table => ({ ...t, foreignKeys });
  const cascadeModel: SchemaModel = {
    enums: [],
    tables: [
      table('users'),
      withFks(table('companies'), [fk('companies_owner', 'users', 'setDefault')]),
      withFks(table('orders'), [
        fk('orders_user', 'users', 'setNull'),
        fk('orders_company', 'companies', 'cascade'),
      ]),
      withFks(table('invoices', 'billing'), [fk('invoices_order', 'orders')]),
      withFks(table('secrets'), [fk('secrets_user', 'users', 'cascade')]),
      withFks(table('order_items'), [
        fk('order_items_order', 'orders', 'cascade'),
        fk('order_items_parent', 'order_items', 'cascade'),
      ]),
      withFks(table('notes'), [fk('notes_item', 'order_items', 'setNull')]),
      withFks(table('tags'), [fk('tags_note', 'notes')]),
    ],
  };
  const warningsFor = (config: unknown, actionDeletes?: Set<string>) => {
    const parsed = wardenConfigSchema.parse({
      schemas: ['public', 'billing'],
      ...(config as object),
    });
    const { schema } = resolveSchema(cascadeModel, parsed);
    const { policy } = resolvePolicy(schema, parsed);
    return deleteCascadeWarnings(cascadeModel, schema, policy, actionDeletes);
  };

  it('names every table, hidden ones included, that deleting changes', () => {
    expect(
      warningsFor({
        roles: { ops: { grants: { users: ['delete'] } } },
        tables: { users: { allowDelete: true }, secrets: { hidden: true } },
      }),
    ).toEqual([
      {
        path: 'tables.users',
        message:
          'deleting a row here also changes rows in "public.companies" (on delete set default), ' +
          '"public.orders" (on delete set null), "public.secrets" (on delete cascade), ' +
          "outside Warden's policy and audit log",
      },
    ]);
  });

  it('follows cascades down the chain, and stops at cycles', () => {
    expect(
      warningsFor({
        roles: { ops: { grants: { companies: ['delete'] } } },
        tables: { companies: { allowDelete: true } },
      }),
    ).toEqual([
      {
        path: 'tables.companies',
        message:
          'deleting a row here also changes rows in "public.orders" (on delete cascade), ' +
          '"public.order_items" (on delete cascade, via "public.orders"), ' +
          '"public.order_items" (on delete cascade, via "public.order_items"), ' +
          '"public.notes" (on delete set null, via "public.order_items"), ' +
          "outside Warden's policy and audit log",
      },
    ]);
  });

  it('says nothing where nobody may delete, or nothing cascades', () => {
    // Off by default; opted in with no grant; denied; `no action` foreign keys only.
    expect(warningsFor({ roles: { ops: { grants: { users: ['delete'] } } } })).toEqual([]);
    expect(warningsFor({ tables: { users: { allowDelete: true } } })).toEqual([]);
    expect(
      warningsFor({
        roles: { ops: { grants: { users: ['delete'] } } },
        tables: { users: { allowDelete: true, deny: ['delete'] } },
      }),
    ).toEqual([]);
    expect(
      warningsFor({
        roles: { ops: { grants: { notes: ['delete'] } } },
        tables: { notes: { allowDelete: true } },
      }),
    ).toEqual([]);
  });

  it('counts tables custom actions may delete from', () => {
    const warnings = warningsFor(
      { tables: { companies: { allowDelete: true } } },
      new Set(['companies']),
    );
    expect(warnings.map((w) => w.path)).toEqual(['tables.companies']);
  });
});
