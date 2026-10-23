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
  grants: z
    .record(
      z.string().regex(/^(\*|[^.*]+(\.[^.*]+)?)$/, 'Expected "*", "table" or "schema.table"'),
      actions,
    )
    .default({})
    .meta({
      description:
        'Actions this role may perform, keyed by table ("users", "billing.invoices") or "*" for ' +
        'every exposed table. "*" can\'t grant delete.',
    }),
  /** They show names that config hides, so grant them narrowly. */
  admin: z
    .array(z.enum(ADMIN_AREAS))
    .default([])
    .meta({
      description:
        'Warden administration areas this role may use: schema (drift page), audit (audit log), ' +
        'roles (assigning roles), views (sharing and managing shared views).',
    }),
  actions: z
    .array(z.union([z.literal('*'), actionName]))
    .default([])
    .meta({
      description:
        'Custom actions this role may run, or "*" for all. Running one doesn\'t need the table ' +
        "grants it writes with, but a table's deny still disables it.",
    }),
});

const actionConfigSchema = z.strictObject({
  disabled: z
    .boolean()
    .optional()
    .meta({ description: 'Nobody may run it, whatever their roles grant.' }),
  requireReason: z
    .boolean()
    .optional()
    .meta({
      description:
        "Whether running it must say why. Overrides the action's own requireReason either way; a " +
        "table's requireReason covering a write the action may make still requires one.",
    }),
  label: name.optional().meta({ description: "Overrides the action's own label." }),
});

const roleList = z.array(name).min(1);

const accessConfigSchema = z.strictObject({
  groupsClaim: name.default('groups').meta({
    description: "ID token claim holding the user's groups: a list of strings, or one string.",
  }),
  groups: z
    .record(name, roleList)
    .default({})
    .meta({ description: 'Roles for each IdP group. Group names match exactly.' }),
  emailDomains: z
    .record(
      z
        .string()
        .regex(/^[^@\s]+\.[^@\s]+$/, 'Expected a domain such as "example.com"')
        // Matched as ASCII only, so look-alike characters can't fold onto another domain.
        .regex(/^[\x21-\x7e]+$/, 'Expected an ASCII domain; write internationalized ones as xn--'),
      roleList,
    )
    .default({})
    .meta({
      description:
        'Roles for everyone whose email is at each domain (exact match, not subdomains; ASCII, ' +
        'punycode for internationalized domains).',
    }),
  requireVerifiedEmail: z
    .boolean()
    .default(true)
    .meta({
      description:
        'Only match emailDomains and role assignments, and only record the email, when the IdP ' +
        'says it is verified (email_verified: true). Turn off only for IdPs that never send the ' +
        "claim and don't let users set their own email.",
    }),
  allowAll: z
    .boolean()
    .default(false)
    .meta({
      description:
        'Let in everyone the IdP authenticates, with no roles unless a rule or assignment gives ' +
        'some. Only for IdPs that already restrict who can sign in.',
    }),
});

const actorConfigSchema = z.strictObject({
  table: tableKey.meta({
    description:
      'The users table: "table" (in the first schema) or "schema.table". It may be hidden.',
  }),
  matchColumn: name.meta({
    description: "Text column matched, ignoring case, against the user's verified email.",
  }),
  idColumn: name.meta({
    description: "Column whose value (as text) is recorded as the actor's user id.",
  }),
  required: z.boolean().default(false).meta({
    description:
      'Deny sign-in to users with no single matching row, and to everyone if the mapping is broken.',
  }),
});

const columnConfigSchema = z.strictObject({
  hidden: z.boolean().optional().meta({
    description:
      'Remove the column completely: never selected, returned, shown, or accepted as input.',
  }),
  readOnly: z
    .boolean()
    .optional()
    .meta({ description: 'Show the column but never accept writes to it.' }),
  label: name.optional().meta({ description: 'The name shown in the UI.' }),
  readableBy: roleList.optional().meta({
    description: 'Only these roles see the column; to everyone else it is hidden.',
  }),
  writableBy: roleList.optional().meta({
    description:
      'Only these roles may write the column; everyone else sees it read-only. Each must also be ' +
      'in readableBy when both are set.',
  }),
});

/** Config view keys: lowercase words joined by hyphens, as in `?view=config:fraud-review`. */
export const VIEW_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A shared grid view defined in config. Fields are checked against the database at startup. */
const viewConfigSchema = z.strictObject({
  key: z
    .string()
    .max(100)
    .regex(VIEW_KEY, 'Expected lowercase letters, digits and hyphens, such as "fraud-review"')
    .meta({
      description:
        'Stable id, unique across all tables. Links use ?view=config:<key>, so keep it stable.',
    }),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((n) => !n.includes('\0'), 'Must not contain NUL')
    .meta({ description: 'Shown in the Views menu and the sidebar.' }),
  filter: z
    .unknown()
    .optional()
    .meta({
      description:
        'A filter, as the list endpoint takes it: { field, op, value }, or { and: [...] }, ' +
        '{ or: [...] }, { not: ... } around others. Checked at startup.',
    }),
  search: z.string().trim().min(1).max(1000).optional().meta({ description: 'Free-text search.' }),
  sort: z
    .array(
      z.strictObject({
        column: name,
        direction: z.enum(['asc', 'desc']).default('asc'),
      }),
    )
    .min(1)
    .optional()
    .meta({ description: 'The sort, as { column, direction: asc | desc }.' }),
  columns: z.array(name).min(1).optional().meta({
    description: "Visible columns, in the grid's usual order. Without it, every column is shown.",
  }),
  sidebar: z
    .boolean()
    .optional()
    .meta({ description: 'Give the view its own entry in the sidebar, under Queues.' }),
  default: z.boolean().optional().meta({
    description:
      'Apply this view when the table is opened without other grid state. One per table.',
  }),
});

const tableConfigSchema = z
  .strictObject({
    hidden: z
      .boolean()
      .optional()
      .meta({
        description:
          "Remove the table completely: it doesn't appear anywhere, and requesting it returns " +
          "the same 404 as a table that doesn't exist.",
      }),
    label: name.optional().meta({ description: 'The name shown in the UI.' }),
    displayField: name.optional().meta({
      description:
        "Column used to represent this table's rows elsewhere, such as foreign key links and pickers.",
    }),
    defaultSort: z
      .strictObject({
        column: name,
        direction: z.enum(['asc', 'desc']).default('asc'),
      })
      .optional()
      .meta({
        description:
          "The grid's initial sort, and the order of API lists and exports that don't name one.",
      }),
    columnOrder: z.array(name).optional().meta({
      description:
        'Columns the grid shows first, left to right; the rest follow in the default order.',
    }),
    searchable: z.array(name).optional().meta({
      description:
        "Columns the grid's free-text search matches against. Default: every visible text column.",
    }),
    columns: z
      .record(name, columnConfigSchema)
      .default({})
      .meta({ description: 'Per-column config, keyed by column name.' }),
    deny: actions.optional().meta({
      description:
        'Actions nobody may perform on this table, whatever their roles grant. Beats every grant.',
    }),
    allowDelete: z
      .boolean()
      .optional()
      .meta({
        description:
          'Turn hard delete on (true) or off (false) for this table, overriding defaults.delete. ' +
          'A role still needs delete on the table by name, and a deny that includes delete wins.',
      }),
    requireReason: z
      .array(z.enum(WRITE_ACTIONS))
      .optional()
      .meta({
        description:
          'Writes on this table that must say why, stored in the audit log. Overrides ' +
          'defaults.requireReason either way ([] makes reasons optional here).',
      }),
    /**
     * Off by default: a new key gives the row a new record id and splits its audit history, and
     * `on update cascade` foreign keys would change rows in other tables outside Warden's policy
     * and audit.
     */
    updatablePrimaryKey: z
      .boolean()
      .optional()
      .meta({
        description:
          'Let updates change primary key columns. A new key gives the row a new record id and ' +
          'splits its audit history. Only for natural keys that really do change.',
      }),
    /**
     * Off by default: an explicit key doesn't advance the sequence, so later inserts, Warden's or
     * the application's, fail with unique violations when it reaches that key.
     */
    insertablePrimaryKey: z
      .boolean()
      .optional()
      .meta({
        description:
          'Let creates set primary key columns that have a default (sequence, identity, or ' +
          "default expression). An explicit key doesn't advance the sequence.",
      }),
    views: z
      .array(viewConfigSchema)
      .optional()
      .meta({ description: 'Shared grid views of this table, read-only in the UI.' }),
    softDelete: z
      .strictObject({
        column: name.meta({
          description: 'Set on delete: a timestamp to now(), a boolean to true.',
        }),
        by: name.optional().meta({
          description:
            "Set to the actor's user id (see actor) on delete, null without one; cleared on restore.",
        }),
      })
      .optional()
      .meta({
        description:
          'Deleting a row sets column instead of removing it, under the same delete grant. ' +
          'Deleted rows are left out of lists unless asked for; roles granted update may restore them.',
      }),
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
    if (table.views?.length && table.hidden) {
      ctx.addIssue({
        code: 'custom',
        path: ['views'],
        message: 'a hidden table cannot have views',
      });
    }
    const defaults = table.views?.flatMap((v, i) => (v.default ? [i] : [])) ?? [];
    for (const i of defaults.slice(1)) {
      ctx.addIssue({
        code: 'custom',
        path: ['views', i, 'default'],
        message: 'only one view per table can be the default',
      });
    }
    // Everyone who can see the table must be able to tell a deleted row from a live one.
    if (table.softDelete) {
      const { column, by } = table.softDelete;
      const columns: [string, string][] = [['column', column]];
      if (by) columns.push(['by', by]);
      for (const [key, name] of columns) {
        const config = table.columns[name];
        const problem = config?.hidden
          ? 'is hidden'
          : config?.readableBy
            ? 'has readableBy'
            : undefined;
        if (problem) {
          ctx.addIssue({
            code: 'custom',
            path: ['softDelete', key],
            message: `"${name}" ${problem} and cannot be used for soft delete`,
          });
        }
      }
      if (by === column) {
        ctx.addIssue({
          code: 'custom',
          path: ['softDelete', 'by'],
          message: '`by` must be a different column from `column`',
        });
      }
    }
  });

/** Audit entry fields Warden writes, mapped to a column of the audit table (`audit.columns`). */
const auditColumnsSchema = z.strictObject({
  id: name.optional(),
  occurredAt: name.optional(),
  requestId: name.optional(),
  actorSubject: name.optional(),
  actorEmail: name.optional(),
  actorUserId: name.optional(),
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
    store: z.enum(['warden', 'table']).default('warden').meta({
      description: 'warden: warden.audit_log. table: a table you own, named by audit.table.',
    }),
    table: tableKey.optional().meta({
      description:
        '"table" (in the first of schemas) or "schema.table". Required with store: table.',
    }),
    columns: auditColumnsSchema.optional().meta({
      description:
        "The column each audit field is written to. Leave it out to use warden.audit_log's column names.",
    }),
    source: z.strictObject({ column: name, value: name }).optional().meta({
      description:
        "Tags Warden's entries (column = value), for a table that also holds the application's own.",
    }),
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
    // Lets a JSON config name its JSON Schema for editors. YAML uses a comment instead.
    $schema: z
      .string()
      .optional()
      .meta({ description: 'JSON Schema for editor completions. Ignored by Warden.' }),
    schemas: z
      .array(name)
      .min(1)
      .default(['public'])
      .meta({
        description:
          'Postgres schemas Warden introspects. The first is the default schema: its tables are ' +
          'referred to by bare name, others as "schema.table".',
      }),
    defaults: z
      .strictObject({
        expose: z.enum(['all', 'none']).default('all').meta({
          description:
            'all: every introspected table, minus hidden ones. none: only tables listed under tables.',
        }),
        newColumns: z
          .enum(['visible', 'hidden', 'readOnly'])
          .default('visible')
          .meta({
            description:
              'How columns with no entry under tables.<table>.columns are treated: visible, ' +
              'hidden (as if hidden: true), or readOnly.',
          }),
        read: z
          .enum(['all', 'granted'])
          .default('all')
          .meta({
            description:
              'all: everyone who can sign in may read every exposed table. granted: reading a ' +
              'table requires a read grant.',
          }),
        delete: z
          .enum(['none', 'granted'])
          .default('none')
          .meta({
            description:
              'Hard deletes. none: refused on every table unless it sets allowDelete: true. ' +
              'granted: a role\'s delete grant on a table is honored. "*" never grants delete.',
          }),
        requireReason: z
          .array(z.enum(WRITE_ACTIONS))
          .default([...WRITE_ACTIONS])
          .meta({
            description:
              'Writes that must say why (an internal note, stored in the audit log), on tables ' +
              "that don't set their own requireReason. [] makes reasons optional.",
          }),
        reasonMinLength: z.number().int().min(1).max(MAX_REASON_LENGTH).default(10).meta({
          description:
            'The shortest required reason, in characters after trimming, so "." or "fix" doesn\'t count.',
        }),
        sharedViews: z
          .enum(['config', 'ui', 'both'])
          .default('both')
          .meta({
            description:
              'Where shared grid views come from. config: only tables.<table>.views. ui: only ' +
              'views shared in the UI. both: either.',
          }),
      })
      .prefault({})
      .meta({ description: 'Defaults for tables, columns, reads, deletes and reasons.' }),
    tables: z.record(tableKey, tableConfigSchema).default({}).meta({
      description: 'Per-table config, keyed by "table" (default schema) or "schema.table".',
    }),
    roles: z.record(name, roleConfigSchema).default({}).meta({
      description:
        'Roles grant actions on tables. Create, update and delete are denied unless a role grants them.',
    }),
    actions: z.record(actionName, actionConfigSchema).default({}).meta({
      description:
        "Per custom action (from WARDEN_ACTIONS), settings that override the action's own.",
    }),
    access: accessConfigSchema.optional().meta({
      description:
        'Required. Who may sign in, and which roles they get, from the claims in the ID token.',
    }),
    audit: auditConfigSchema.prefault({}).meta({ description: 'Where the audit log is written.' }),
    actor: actorConfigSchema.optional().meta({
      description:
        'Maps each signed-in user to a row of your own users table, by verified email, so audit ' +
        'entries record their internal user id.',
    }),
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
    // Keys are global so `?view=config:<key>` names one view without its table.
    const viewKeys = new Map<string, string>();
    for (const [key, table] of Object.entries(config.tables)) {
      table.views?.forEach((view, i) => {
        const path = ['tables', key, 'views', i];
        if (config.defaults.sharedViews === 'ui') {
          ctx.addIssue({
            code: 'custom',
            path,
            message: 'config views need `defaults.sharedViews: config` or `both`',
          });
        }
        const other = viewKeys.get(view.key);
        if (other !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'key'],
            message: `view key "${view.key}" is already used by a view of "${other}"`,
          });
        } else viewKeys.set(view.key, key);
      });
    }
    if (config.actor) checkSchema(config.actor.table, ['actor', 'table']);
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
  })
  .meta({
    title: 'Warden config',
    description: 'warden.config.yaml or warden.config.json. See docs/config.md.',
  });

export type WardenConfig = z.infer<typeof wardenConfigSchema>;
export type TableConfig = z.infer<typeof tableConfigSchema>;
export type ColumnConfig = z.infer<typeof columnConfigSchema>;
export type ViewConfig = z.infer<typeof viewConfigSchema>;
export type SharedViewsMode = WardenConfig['defaults']['sharedViews'];
export type RoleConfig = z.infer<typeof roleConfigSchema>;
export type AccessConfig = z.infer<typeof accessConfigSchema>;
export type ActionConfig = z.infer<typeof actionConfigSchema>;
export type AuditConfig = z.infer<typeof auditConfigSchema>;
export type ActorConfig = z.infer<typeof actorConfigSchema>;
export type Action = (typeof ACTIONS)[number];
export type WriteAction = (typeof WRITE_ACTIONS)[number];
export type AdminArea = (typeof ADMIN_AREAS)[number];
