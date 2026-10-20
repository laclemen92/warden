import { z } from 'zod';

const name = z.string().min(1);

/** `table` (resolved against the first entry in `schemas`) or `schema.table`. */
const tableKey = z.string().regex(/^[^.]+(\.[^.]+)?$/, 'Expected "table" or "schema.table"');

export const ACTIONS = ['read', 'create', 'update', 'delete'] as const;
const actions = z.array(z.enum(ACTIONS));

/**
 * Warden administration areas a role can be given. `schema`: the schema drift page. `audit`: the
 * audit log page. `roles`: assigning roles to users in the app.
 */
export const ADMIN_AREAS = ['schema', 'audit', 'roles'] as const;

const roleConfigSchema = z.strictObject({
  /** Actions this role may perform, keyed by table, or `*` for every exposed table. */
  grants: z
    .record(
      z.string().regex(/^(\*|[^.*]+(\.[^.*]+)?)$/, 'Expected "*", "table" or "schema.table"'),
      actions,
    )
    .default({}),
  /** Admin areas this role may use. They show names that config hides, so grant them narrowly. */
  admin: z.array(z.enum(ADMIN_AREAS)).default([]),
});

const roleList = z.array(name).min(1);

const accessConfigSchema = z.strictObject({
  /** ID token claim holding the user's groups: a list of strings, or one string. */
  groupsClaim: name.default('groups'),
  /** Roles for each IdP group. */
  groups: z.record(name, roleList).default({}),
  /** Roles for everyone whose email is at each domain (exact match, not subdomains). */
  emailDomains: z
    .record(
      z.string().regex(/^[^@\s]+\.[^@\s]+$/, 'Expected a domain such as "example.com"'),
      roleList,
    )
    .default({}),
  /**
   * Only match `emailDomains` when the IdP says the email is verified (`email_verified: true`).
   * Turn off only for IdPs that never send the claim and don't let users set their own email.
   */
  requireVerifiedEmail: z.boolean().default(true),
});

const columnConfigSchema = z.strictObject({
  /** Never sent to the UI or returned by the API. */
  hidden: z.boolean().optional(),
  /** Shown but never writable. */
  readOnly: z.boolean().optional(),
  label: name.optional(),
  /** Only these roles see the column; to everyone else it is hidden. */
  readableBy: roleList.optional(),
  /** Only these roles may write the column; everyone else sees it read-only. */
  writableBy: roleList.optional(),
});

const tableConfigSchema = z
  .strictObject({
    hidden: z.boolean().optional(),
    label: name.optional(),
    /** Column used when this table's rows are referenced elsewhere (FK links, pickers). */
    displayField: name.optional(),
    defaultSort: z
      .strictObject({
        column: name,
        direction: z.enum(['asc', 'desc']).default('asc'),
      })
      .optional(),
    /** Columns included in the grid's free-text search. */
    searchable: z.array(name).optional(),
    columns: z.record(name, columnConfigSchema).default({}),
    /** Actions nobody may perform on this table, whatever their roles grant. */
    deny: actions.optional(),
  })
  .superRefine((table, ctx) => {
    for (const [column, config] of Object.entries(table.columns)) {
      const issue = (key: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: ['columns', column, key], message });
      if (config.hidden && config.readableBy) {
        issue('readableBy', 'a hidden column is readable by nobody; remove one of the two');
      }
      if (config.readOnly && config.writableBy) {
        issue('writableBy', 'a read-only column is writable by nobody; remove one of the two');
      }
      // Writing a column you can't see would be editing blind.
      config.writableBy?.forEach((role, i) => {
        if (config.readableBy && !config.readableBy.includes(role)) {
          ctx.addIssue({
            code: 'custom',
            path: ['columns', column, 'writableBy', i],
            message: `role "${role}" can write "${column}" but not read it; add it to readableBy`,
          });
        }
      });
    }
    const hidden = (column: string) => table.columns[column]?.hidden === true;
    if (table.displayField && hidden(table.displayField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['displayField'],
        message: `"${table.displayField}" is hidden and cannot be the display field`,
      });
    }
    if (table.defaultSort && hidden(table.defaultSort.column)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultSort', 'column'],
        message: `"${table.defaultSort.column}" is hidden and cannot be sorted on`,
      });
    }
    table.searchable?.forEach((column, i) => {
      if (hidden(column)) {
        ctx.addIssue({
          code: 'custom',
          path: ['searchable', i],
          message: `"${column}" is hidden and cannot be searchable`,
        });
      }
    });
  });

export const wardenConfigSchema = z
  .strictObject({
    /** Database schemas to introspect. The first is the default for unqualified table keys. */
    schemas: z.array(name).min(1).default(['public']),
    defaults: z
      .strictObject({
        /** `all` exposes every introspected table; `none` exposes only tables listed under `tables`. */
        expose: z.enum(['all', 'none']).default('all'),
        /** How columns not mentioned in config are treated. */
        newColumns: z.enum(['visible', 'hidden', 'readOnly']).default('visible'),
        /** `all`: anyone may read every exposed table. `granted`: reading requires a `read` grant. */
        read: z.enum(['all', 'granted']).default('all'),
      })
      .prefault({}),
    tables: z.record(tableKey, tableConfigSchema).default({}),
    roles: z.record(name, roleConfigSchema).default({}),
    /** Who may sign in, and with which roles. Without it, every IdP user signs in with no roles. */
    access: accessConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const checkSchema = (key: string, path: string[]) => {
      const [schema] = key.split('.');
      if (key.includes('.') && schema && !config.schemas.includes(schema)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `schema "${schema}" is not listed in \`schemas\``,
        });
      }
    };
    for (const [key, table] of Object.entries(config.tables)) {
      checkSchema(key, ['tables', key]);
      for (const [column, columnConfig] of Object.entries(table.columns)) {
        for (const rule of ['readableBy', 'writableBy'] as const) {
          columnConfig[rule]?.forEach((role, i) => {
            if (!Object.hasOwn(config.roles, role)) {
              ctx.addIssue({
                code: 'custom',
                path: ['tables', key, 'columns', column, rule, i],
                message: `role "${role}" is not defined in \`roles\``,
              });
            }
          });
        }
      }
    }
    for (const [role, { grants }] of Object.entries(config.roles)) {
      for (const key of Object.keys(grants)) checkSchema(key, ['roles', role, 'grants', key]);
    }
    const checkRoles = (rules: Record<string, string[]>, section: string) => {
      for (const [key, roles] of Object.entries(rules)) {
        roles.forEach((role, i) => {
          if (!Object.hasOwn(config.roles, role)) {
            ctx.addIssue({
              code: 'custom',
              path: ['access', section, key, i],
              message: `role "${role}" is not defined in \`roles\``,
            });
          }
        });
      }
    };
    if (config.access) {
      checkRoles(config.access.groups, 'groups');
      checkRoles(config.access.emailDomains, 'emailDomains');
      const domains = new Set<string>();
      for (const domain of Object.keys(config.access.emailDomains)) {
        const lower = domain.toLowerCase();
        if (domains.has(lower)) {
          ctx.addIssue({
            code: 'custom',
            path: ['access', 'emailDomains', domain],
            message: `domain "${lower}" is listed more than once`,
          });
        }
        domains.add(lower);
      }
    }
  });

export type WardenConfig = z.infer<typeof wardenConfigSchema>;
export type TableConfig = z.infer<typeof tableConfigSchema>;
export type ColumnConfig = z.infer<typeof columnConfigSchema>;
export type RoleConfig = z.infer<typeof roleConfigSchema>;
export type AccessConfig = z.infer<typeof accessConfigSchema>;
export type Action = (typeof ACTIONS)[number];
export type AdminArea = (typeof ADMIN_AREAS)[number];
