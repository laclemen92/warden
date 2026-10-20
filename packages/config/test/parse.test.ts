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
  schema-admin: { admin: [schema] }
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
      'schema-admin': { grants: {}, admin: ['schema'] },
    });
    expect(config.tables.orders?.deny).toEqual(['create', 'delete']);
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
    admin: [roles]
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
