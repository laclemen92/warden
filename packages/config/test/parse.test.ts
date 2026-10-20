import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/index.js';

const FILE = '/etc/warden/warden.config.yaml';

function issues(source: string) {
  try {
    parseConfig(source, FILE);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected config to be invalid');
}

describe('parseConfig', () => {
  it('exposes everything, read-only, when the file is empty', () => {
    expect(parseConfig('', FILE)).toEqual({
      schemas: ['public'],
      defaults: { expose: 'all', newColumns: 'visible', read: 'all' },
      tables: {},
      roles: {},
    });
  });

  it('parses a full YAML config and fills nested defaults', () => {
    const config = parseConfig(
      `
schemas: [public, billing]
defaults:
  expose: none
tables:
  users:
    label: People
    displayField: email
    defaultSort: { column: created_at }
    searchable: [email, full_name]
    columns:
      password_hash: { hidden: true }
      created_at: { readOnly: true, label: Joined }
  billing.invoices: {}
`,
      FILE,
    );
    expect(config.defaults).toEqual({ expose: 'none', newColumns: 'visible', read: 'all' });
    expect(config.tables.users).toEqual({
      label: 'People',
      displayField: 'email',
      defaultSort: { column: 'created_at', direction: 'asc' },
      searchable: ['email', 'full_name'],
      columns: {
        password_hash: { hidden: true },
        created_at: { readOnly: true, label: 'Joined' },
      },
    });
    expect(config.tables['billing.invoices']).toEqual({ columns: {} });
  });

  it('parses JSON', () => {
    const config = parseConfig(
      JSON.stringify({ tables: { users: { hidden: true } } }),
      'warden.config.json',
    );
    expect(config.tables.users?.hidden).toBe(true);
  });

  it('points unknown keys at the offending key with line and column', () => {
    expect(
      issues(`tables:
  users:
    columns:
      password_hash:
        hiden: true
`),
    ).toEqual([
      {
        path: 'tables.users.columns.password_hash.hiden',
        message: 'Unrecognized key: "hiden"',
        line: 5,
        column: 9,
      },
    ]);
  });

  it('reports type and enum errors at the value', () => {
    const result = issues(`defaults:
  expose: everything
tables:
  users:
    hidden: "yes"
`);
    expect(result).toMatchObject([
      { path: 'defaults.expose', line: 2, column: 11 },
      { path: 'tables.users.hidden', line: 5, column: 13 },
    ]);
    expect(result[0]?.message).toMatch(/all.*none/);
  });

  it('rejects hidden columns used as displayField, sort, or search', () => {
    expect(
      issues(`tables:
  users:
    displayField: password_hash
    defaultSort: { column: password_hash, direction: desc }
    searchable: [email, password_hash]
    columns:
      password_hash: { hidden: true }
`).map((i) => i.path),
    ).toEqual([
      'tables.users.displayField',
      'tables.users.defaultSort.column',
      'tables.users.searchable.1',
    ]);
  });

  it('requires qualified table keys to use a listed schema', () => {
    expect(issues(`tables:\n  billing.invoices: {}\n`)).toMatchObject([
      { path: 'tables.billing.invoices', message: 'schema "billing" is not listed in `schemas`' },
    ]);
  });

  it('parses roles, grants, and per-table deny', () => {
    const config = parseConfig(
      `
roles:
  viewer: { grants: { "*": [read] } }
  ops:
    grants:
      users: [read, update]
      companies: [read, create, update]
  nobody: {}
  schema-admin: { admin: [schema, roles] }
tables:
  orders: { deny: [create, delete] }
`,
      FILE,
    );
    expect(config.roles).toEqual({
      viewer: { grants: { '*': ['read'] }, admin: [] },
      ops: {
        grants: { users: ['read', 'update'], companies: ['read', 'create', 'update'] },
        admin: [],
      },
      nobody: { grants: {}, admin: [] },
      'schema-admin': { grants: {}, admin: ['schema', 'roles'] },
    });
    expect(config.tables.orders?.deny).toEqual(['create', 'delete']);
  });

  it('parses requireReason, which only takes write actions', () => {
    const config = parseConfig('tables:\n  users: { requireReason: [update, delete] }\n', FILE);
    expect(config.tables.users?.requireReason).toEqual(['update', 'delete']);
    expect(
      issues('tables:\n  users: { requireReason: [read] }\n').map((i) => [i.path, i.line]),
    ).toEqual([['tables.users.requireReason.0', 2]]);
  });

  it('rejects unknown actions and role keys', () => {
    expect(
      issues(`tables:
  orders: { deny: [drop] }
roles:
  ops:
    grants:
      users: [read, write]
    grant: {}
    admin: [users]
`).map((i) => [i.path, i.line]),
    ).toEqual([
      ['tables.orders.deny.0', 2],
      ['roles.ops.grants.users.1', 6],
      ['roles.ops.admin.0', 8],
      ['roles.ops.grant', 7],
    ]);
  });

  it('rejects malformed grant keys', () => {
    for (const key of ['a.b.c', '**', 'users*', '']) {
      expect(issues(`roles:\n  ops:\n    grants:\n      "${key}": [read]\n`)).toMatchObject([
        { path: `roles.ops.grants.${key}`, message: 'Expected "*", "table" or "schema.table"' },
      ]);
    }
  });

  it('requires qualified grant keys to use a listed schema', () => {
    expect(issues(`roles:\n  ops:\n    grants:\n      billing.invoices: [read]\n`)).toMatchObject([
      {
        path: 'roles.ops.grants.billing.invoices',
        message: 'schema "billing" is not listed in `schemas`',
        line: 4,
      },
    ]);
  });

  it('parses access rules and fills their defaults', () => {
    const config = parseConfig(
      `
roles:
  viewer: {}
  admin: {}
access:
  groups:
    warden-admins: [admin, viewer]
  emailDomains:
    example.com: [viewer]
`,
      FILE,
    );
    expect(config.access).toEqual({
      groupsClaim: 'groups',
      groups: { 'warden-admins': ['admin', 'viewer'] },
      emailDomains: { 'example.com': ['viewer'] },
      requireVerifiedEmail: true,
      allowAll: false,
    });
    expect(parseConfig('roles: {}', FILE).access).toBeUndefined();
  });

  it('requires access rules to name defined roles', () => {
    expect(
      issues(`roles:
  viewer: {}
access:
  groups:
    admins: [viewer, admin]
  emailDomains:
    example.com: [constructor]
`),
    ).toMatchObject([
      {
        path: 'access.groups.admins.1',
        message: 'role "admin" is not defined in `roles`',
        line: 5,
      },
      {
        path: 'access.emailDomains.example.com.0',
        message: 'role "constructor" is not defined in `roles`',
        line: 7,
      },
    ]);
  });

  it('rejects empty role lists, malformed domains, and duplicate domains', () => {
    expect(
      issues(`roles:
  viewer: {}
access:
  groups:
    admins: []
  emailDomains:
    "@example.com": [viewer]
    Example.COM: [viewer]
    example.com: [viewer]
  groupClaim: groups
`).map((i) => i.path),
    ).toEqual(['access.groups.admins', 'access.emailDomains.@example.com', 'access.groupClaim']);
    expect(
      issues(
        `roles:\n  viewer: {}\naccess:\n  emailDomains:\n    Example.COM: [viewer]\n    example.com: [viewer]\n`,
      ),
    ).toMatchObject([
      {
        path: 'access.emailDomains.example.com',
        message: 'domain "example.com" is listed more than once',
      },
    ]);
  });

  it('rejects a table configured as both `table` and `schema.table`, pointing at both keys', () => {
    // Field rules split across the two keys would let support write salary.
    expect(
      issues(`roles:
  hr: {}
  support: {}
tables:
  users:
    columns:
      salary: { readableBy: [hr], writableBy: [hr] }
  public.users:
    columns:
      salary: { writableBy: [hr, support] }
`),
    ).toEqual([
      {
        path: 'tables.users',
        message: '"users" and "public.users" are the same table; configure it under one key',
        line: 5,
        column: 3,
      },
      {
        path: 'tables.public.users',
        message: '"users" and "public.users" are the same table; configure it under one key',
        line: 8,
        column: 3,
      },
    ]);
    // A hidden column under the second key would be ignored.
    expect(
      issues(`tables:
  users: { label: Users }
  public.users:
    columns:
      ssn: { hidden: true }
`).map((i) => [i.path, i.line]),
    ).toEqual([
      ['tables.users', 2],
      ['tables.public.users', 3],
    ]);
  });

  it('resolves duplicate keys against the first schema', () => {
    expect(
      issues('schemas: [ops, public]\ntables:\n  audit: {}\n  ops.audit: {}\n').map((i) => i.path),
    ).toEqual(['tables.audit', 'tables.ops.audit']);
    // `users` is ops.users here, so public.users is a different table.
    expect(() =>
      parseConfig('schemas: [ops, public]\ntables:\n  users: {}\n  public.users: {}\n', FILE),
    ).not.toThrow();
  });

  it("rejects a table granted under both spellings in one role's grants", () => {
    expect(
      issues(`roles:
  ops:
    grants:
      '*': [read]
      users: [read]
      public.users: [update]
  other:
    grants:
      users: [read]
`),
    ).toMatchObject([
      { path: 'roles.ops.grants.users', line: 5 },
      { path: 'roles.ops.grants.public.users', line: 6 },
    ]);
  });

  it('parses per-column readableBy and writableBy', () => {
    const config = parseConfig(
      `roles:
  admin: {}
  hr: {}
tables:
  users:
    columns:
      role: { writableBy: [admin] }
      salary: { readableBy: [hr, admin], writableBy: [hr] }
`,
      FILE,
    );
    expect(config.tables.users?.columns).toEqual({
      role: { writableBy: ['admin'] },
      salary: { readableBy: ['hr', 'admin'], writableBy: ['hr'] },
    });
  });

  it('rejects column rules that name unknown roles or contradict each other', () => {
    expect(
      issues(`roles:
  admin: {}
  hr: {}
tables:
  users:
    columns:
      c: { hidden: true, readableBy: [admin] }
      d: { readOnly: true, writableBy: [admin] }
      e: { readableBy: [hr], writableBy: [admin, hr] }
      f: { readableBy: [] }
`),
    ).toMatchObject([
      // Shape errors come before the cross-field checks.
      { path: 'tables.users.columns.f.readableBy' },
      { path: 'tables.users.columns.c.readableBy', message: expect.stringContaining('hidden') },
      { path: 'tables.users.columns.d.writableBy', message: expect.stringContaining('read-only') },
      {
        path: 'tables.users.columns.e.writableBy.0',
        message: 'role "admin" can write "e" but not read it; add it to readableBy',
      },
    ]);
    expect(
      issues(`roles:
  admin: {}
tables:
  users:
    columns:
      a: { readableBy: [nobody] }
      b: { writableBy: [constructor] }
`),
    ).toMatchObject([
      {
        path: 'tables.users.columns.a.readableBy.0',
        message: 'role "nobody" is not defined in `roles`',
      },
      {
        path: 'tables.users.columns.b.writableBy.0',
        message: 'role "constructor" is not defined in `roles`',
      },
    ]);
  });

  it('rejects malformed table keys', () => {
    expect(issues(`tables:\n  a.b.c: {}\n`)).toMatchObject([
      { path: 'tables.a.b.c', message: 'Expected "table" or "schema.table"' },
    ]);
  });

  it('reports YAML syntax errors and duplicate keys with positions', () => {
    expect(issues(`tables:\n  users: [unclosed\n`)[0]).toMatchObject({ path: '', line: 3 });
    expect(issues(`tables:\n  users: {}\n  users: {}\n`)[0]).toMatchObject({
      message: expect.stringMatching(/unique/i),
      line: 3,
    });
  });

  it('formats every issue in the error message with the file path', () => {
    expect(() => parseConfig('defaults: { expose: 1 }', FILE)).toThrow(
      /Invalid Warden config \/etc\/warden\/warden\.config\.yaml:\n {2}- defaults\.expose \(line 1, col 21\): /,
    );
  });
});
