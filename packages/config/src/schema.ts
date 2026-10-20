import { z } from 'zod';

const name = z.string().min(1);

/** `table` (resolved against the first entry in `schemas`) or `schema.table`. */
const tableKey = z.string().regex(/^[^.]+(\.[^.]+)?$/, 'Expected "table" or "schema.table"');

/** `export`: downloading a grid as CSV. It also needs `read`, and `defaults.read` doesn't grant it. */
export const ACTIONS = ['read', 'create', 'update', 'delete', 'export'] as const;
const actions = z.array(z.enum(ACTIONS));
export const WRITE_ACTIONS = ['create', 'update', 'delete'] as const;

/**
 * Warden administration areas a role can be given. `schema`: the schema drift page. `audit`: the
 * audit log page. `roles`: assigning roles to users in the app. `views`: sharing saved grid views
 * with everyone, and managing every shared view.
 */
export const ADMIN_AREAS = ['schema', 'audit', 'roles', 'views'] as const;

/** Custom action names, as `defineAction({ name })` gives them. */
export const ACTION_NAME = /^[a-z][a-z0-9-]*$/;
const actionName = z.string().regex(ACTION_NAME, 'Expected an action name such as "move-user"');

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
  /**
   * Custom actions this role may run, or `*` for all. Running one doesn't need the table grants
   * it writes with, but a table `deny` still disables it.
   */
  actions: z.array(z.union([z.literal('*'), actionName])).default([]),
});

const actionConfigSchema = z.strictObject({
  /** Nobody may run it, whatever their roles grant. */
  disabled: z.boolean().optional(),
  /** Running it must say why, even if the action doesn't require it. */
  requireReason: z.boolean().optional(),
  /** Overrides the action's own label. */
  label: name.optional(),
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
  /**
   * Let in everyone the IdP authenticates, with no roles unless a rule or assignment gives some.
   * Only for IdPs that already restrict who can sign in.
   */
  allowAll: z.boolean().default(false),
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
    /** Writes that must say why; the reason is stored in the audit log. */
    requireReason: z.array(z.enum(WRITE_ACTIONS)).optional(),
    /**
     * Let updates change primary key columns. Off by default: a new key gives the row a new
     * record id and splits its audit history, and `on update cascade` foreign keys would change
     * rows in other tables outside Warden's policy and audit.
     */
    updatablePrimaryKey: z.boolean().optional(),
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
    /** Per custom action (from `WARDEN_ACTIONS`), settings that override the action's own. */
    actions: z.record(actionName, actionConfigSchema).default({}),
    /** Who may sign in, and with which roles. The server requires it (see `requireAccess`). */
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
    // `users` and `public.users` (against the first schema) are the same table. The resolvers
    // would each pick or merge the two entries differently, dropping hidden columns and field
    // rules, so two spellings are invalid config rather than a warning.
    const checkDuplicateKeys = (keys: string[], path: string[]) => {
      const defaultSchema = config.schemas[0] ?? 'public';
      const seen = new Map<string, string>();
      for (const key of keys) {
        if (key === '*') continue;
        const qualified = key.includes('.') ? key : `${defaultSchema}.${key}`;
        const first = seen.get(qualified);
        if (first === undefined) {
          seen.set(qualified, key);
          continue;
        }
        for (const k of [first, key]) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, k],
            message: `"${first}" and "${key}" are the same table; configure it under one key`,
            params: { at: 'key' },
          });
        }
      }
    };
    checkDuplicateKeys(Object.keys(config.tables), ['tables']);
    for (const [role, { grants }] of Object.entries(config.roles)) {
      checkDuplicateKeys(Object.keys(grants), ['roles', role, 'grants']);
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
export type ActionConfig = z.infer<typeof actionConfigSchema>;
export type Action = (typeof ACTIONS)[number];
export type WriteAction = (typeof WRITE_ACTIONS)[number];
export type AdminArea = (typeof ADMIN_AREAS)[number];
