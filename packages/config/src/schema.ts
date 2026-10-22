import { z } from 'zod';

const name = z.string().min(1);

/** `table` (resolved against the first entry in `schemas`) or `schema.table`. */
const tableKey = z.string().regex(/^[^.]+(\.[^.]+)?$/, 'Expected "table" or "schema.table"');

/** `export`: downloading a grid as CSV. It also needs `read`, and `defaults.read` doesn't grant it. */
export const ACTIONS = ['read', 'create', 'update', 'delete', 'export'] as const;
const actions = z.array(z.enum(ACTIONS));
export const WRITE_ACTIONS = ['create', 'update', 'delete'] as const;
/** The longest reason a write or action may give. */
export const MAX_REASON_LENGTH = 2000;

/**
 * Warden administration areas a role can be given. `schema`: the schema drift page. `audit`: the
 * audit log page. `roles`: assigning roles to users in the app. `views`: sharing saved grid views
 * with everyone, and managing every shared view.
 */
export const ADMIN_AREAS = ['schema', 'audit', 'roles', 'views'] as const;

/** Custom action names, as `defineAction({ name })` gives them. */
export const ACTION_NAME = /^[a-z][a-z0-9-]*$/;
/**
 * Audit log actions Warden writes itself. A custom action's entry records its name as the action,
 * so one with these names would read as a built-in entry (an action named `delete` as a row delete).
 */
export const RESERVED_ACTION_NAMES: readonly string[] = [
  ...WRITE_ACTIONS,
  'export',
  'assign',
  'unassign',
  'acknowledge',
];
const actionName = z
  .string()
  .regex(ACTION_NAME, 'Expected an action name such as "move-user"')
  .refine((name) => !RESERVED_ACTION_NAMES.includes(name), {
    error: (issue) => `"${String(issue.input)}" is reserved for Warden's own audit entries`,
  });

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
  /**
   * Whether running it must say why. Overrides the action's own `requireReason` either way; a
   * table's `requireReason` covering a write the action may make still requires one.
   */
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
      z
        .string()
        .regex(/^[^@\s]+\.[^@\s]+$/, 'Expected a domain such as "example.com"')
        // Matched as ASCII only, so look-alike characters can't fold onto another domain.
        .regex(/^[\x21-\x7e]+$/, 'Expected an ASCII domain; write internationalized ones as xn--'),
      roleList,
    )
    .default({}),
  /**
   * Only match `emailDomains` and role assignments, and only record the email as the audit
   * actor, when the IdP says it is verified (`email_verified: true`). Turn off only for IdPs
   * that never send the claim and don't let users set their own email.
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
    /** Columns the grid shows first, in this order; the rest follow in the default order. */
    columnOrder: z.array(name).optional(),
    /** Columns included in the grid's free-text search. */
    searchable: z.array(name).optional(),
    columns: z.record(name, columnConfigSchema).default({}),
    /** Actions nobody may perform on this table, whatever their roles grant. */
    deny: actions.optional(),
    /**
     * Let roles granted `delete` on this table hard-delete its rows. Overrides `defaults.delete`
     * for this table either way; a `deny` that includes `delete` still wins.
     */
    allowDelete: z.boolean().optional(),
    /**
     * Writes that must say why; the reason is stored in the audit log. Overrides
     * `defaults.requireReason` for this table either way (`[]` turns it off).
     */
    requireReason: z.array(z.enum(WRITE_ACTIONS)).optional(),
    /**
     * Let updates change primary key columns. Off by default: a new key gives the row a new
     * record id and splits its audit history, and `on update cascade` foreign keys would change
     * rows in other tables outside Warden's policy and audit.
     */
    updatablePrimaryKey: z.boolean().optional(),
    /**
     * Let creates set primary key columns that have a default (sequence, identity, or default
     * expression). Off by default: an explicit key doesn't advance the sequence, so later inserts,
     * Warden's or the application's, fail with unique violations when it reaches that key.
     */
    insertablePrimaryKey: z.boolean().optional(),
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
    table.columnOrder?.forEach((column, i) => {
      if (hidden(column)) {
        ctx.addIssue({
          code: 'custom',
          path: ['columnOrder', i],
          message: `"${column}" is hidden and cannot be ordered`,
        });
      } else if (table.columnOrder!.indexOf(column) !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['columnOrder', i],
          message: `"${column}" appears more than once`,
        });
      }
    });
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

/** Audit entry fields Warden writes, mapped to a column of the audit table (`audit.columns`). */
const auditColumnsSchema = z.strictObject({
  id: name.optional(),
  occurredAt: name.optional(),
  requestId: name.optional(),
  actorSubject: name.optional(),
  actorEmail: name.optional(),
  actorRoles: name.optional(),
  action: name.optional(),
  entity: name.optional(),
  recordId: name.optional(),
  primaryKey: name.optional(),
  before: name.optional(),
  after: name.optional(),
  diff: name.optional(),
  details: name.optional(),
  reason: name.optional(),
  written: name.optional(),
  parentId: name.optional(),
});

export type AuditField = keyof z.infer<typeof auditColumnsSchema>;
export const AUDIT_FIELDS = Object.keys(auditColumnsSchema.shape) as AuditField[];
/** The columns `warden.audit_log` stores each field in: `occurredAt` → `occurred_at`. */
export const DEFAULT_AUDIT_COLUMNS = Object.fromEntries(
  AUDIT_FIELDS.map((field) => [field, field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]),
) as Record<AuditField, string>;
/**
 * Fields every mapping must include. Reads depend on `diff` and `details` to keep what a user
 * can't see out of History and the audit log, so they aren't optional.
 */
export const REQUIRED_AUDIT_FIELDS: readonly AuditField[] = [
  'id',
  'occurredAt',
  'actorSubject',
  'action',
  'entity',
  'recordId',
  'diff',
  'details',
];

const auditConfigSchema = z
  .strictObject({
    /** `warden`: `warden.audit_log`. `table`: a table you own, set by `table` and `columns`. */
    store: z.enum(['warden', 'table']).default('warden'),
    /** `table` or `schema.table`, for `store: table`. */
    table: tableKey.optional(),
    /** Field → column. Omitted, every field goes to the column `warden.audit_log` names it. */
    columns: auditColumnsSchema.optional(),
    /** Tags Warden's entries, for a table that also holds the application's own. */
    source: z.strictObject({ column: name, value: name }).optional(),
  })
  .superRefine((audit, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (audit.store === 'warden') {
      for (const key of ['table', 'columns', 'source'] as const) {
        if (audit[key] !== undefined) issue([key], 'only applies with `store: table`');
      }
      return;
    }
    if (audit.table === undefined) issue(['table'], 'is required with `store: table`');
    else if (audit.table.split('.').length === 2 && audit.table.startsWith('warden.')) {
      issue(['table'], "the warden schema is Warden's own; use `store: warden` for its audit log");
    }
    const columns: Partial<Record<AuditField, string | undefined>> =
      audit.columns ?? DEFAULT_AUDIT_COLUMNS;
    for (const field of REQUIRED_AUDIT_FIELDS) {
      if (columns[field] === undefined) issue(['columns'], `"${field}" must be mapped`);
    }
    const used = new Map<string, string>();
    for (const [field, column] of Object.entries(columns)) {
      if (column === undefined) continue;
      const other = used.get(column);
      if (other) issue(['columns', field], `column "${column}" is already mapped to "${other}"`);
      used.set(column, field);
    }
    if (audit.source && used.has(audit.source.column)) {
      issue(
        ['source', 'column'],
        `column "${audit.source.column}" is already mapped to "${used.get(audit.source.column)}"`,
      );
    }
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
        /**
         * Hard deletes. `none`: refused on every table unless it sets `allowDelete: true`.
         * `granted`: a role's `delete` grant on a table is honored. A `*` grant never includes
         * `delete` either way.
         */
        delete: z.enum(['none', 'granted']).default('none'),
        /**
         * Writes that must say why (an internal note, stored in the audit log), on tables that
         * don't set their own `requireReason`. `[]` makes reasons optional.
         */
        requireReason: z.array(z.enum(WRITE_ACTIONS)).default([...WRITE_ACTIONS]),
        /** The shortest required reason, after trimming, so "." or "fix" doesn't count. */
        reasonMinLength: z.number().int().min(1).max(MAX_REASON_LENGTH).default(10),
      })
      .prefault({}),
    tables: z.record(tableKey, tableConfigSchema).default({}),
    roles: z.record(name, roleConfigSchema).default({}),
    /** Per custom action (from `WARDEN_ACTIONS`), settings that override the action's own. */
    actions: z.record(actionName, actionConfigSchema).default({}),
    /** Who may sign in, and with which roles. The server requires it (see `requireAccess`). */
    access: accessConfigSchema.optional(),
    /** Where the audit trail is written. */
    audit: auditConfigSchema.prefault({}),
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
      // Hard delete is granted table by table, so a blanket grant can't hand it out by accident.
      grants['*']?.forEach((action, i) => {
        if (action !== 'delete') return;
        ctx.addIssue({
          code: 'custom',
          path: ['roles', role, 'grants', '*', i],
          message:
            '"*" can\'t grant delete; grant it on each table that should allow it ' +
            '(e.g. orders: [delete]) and set tables.<table>.allowDelete: true',
        });
      });
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
    // The audit table is never exposed, so config for it would read as though it could be.
    if (config.audit.store === 'table' && config.audit.table) {
      const qualify = (key: string) =>
        key.includes('.') ? key : `${config.schemas[0] ?? 'public'}.${key}`;
      const auditTable = qualify(config.audit.table);
      const refuse = (path: string[]) =>
        ctx.addIssue({
          code: 'custom',
          path,
          message: `"${auditTable}" is the audit table, which Warden never exposes`,
          params: { at: 'key' },
        });
      for (const key of Object.keys(config.tables)) {
        if (qualify(key) === auditTable) refuse(['tables', key]);
      }
      for (const [role, { grants }] of Object.entries(config.roles)) {
        for (const key of Object.keys(grants)) {
          if (key !== '*' && qualify(key) === auditTable) refuse(['roles', role, 'grants', key]);
        }
      }
    }
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
export type AuditConfig = z.infer<typeof auditConfigSchema>;
export type Action = (typeof ACTIONS)[number];
export type WriteAction = (typeof WRITE_ACTIONS)[number];
export type AdminArea = (typeof ADMIN_AREAS)[number];
