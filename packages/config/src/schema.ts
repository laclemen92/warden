import { z } from 'zod';

const name = z.string().min(1);

/** `table` (resolved against the first entry in `schemas`) or `schema.table`. */
const tableKey = z.string().regex(/^[^.]+(\.[^.]+)?$/, 'Expected "table" or "schema.table"');

export const ACTIONS = ['read', 'create', 'update', 'delete'] as const;
const actions = z.array(z.enum(ACTIONS));

const roleConfigSchema = z.strictObject({
  /** Actions this role may perform, keyed by table, or `*` for every exposed table. */
  grants: z
    .record(
      z.string().regex(/^(\*|[^.*]+(\.[^.*]+)?)$/, 'Expected "*", "table" or "schema.table"'),
      actions,
    )
    .default({}),
});

const columnConfigSchema = z.strictObject({
  /** Never sent to the UI or returned by the API. */
  hidden: z.boolean().optional(),
  /** Shown but never writable. */
  readOnly: z.boolean().optional(),
  label: name.optional(),
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
    for (const key of Object.keys(config.tables)) checkSchema(key, ['tables', key]);
    for (const [role, { grants }] of Object.entries(config.roles)) {
      for (const key of Object.keys(grants)) checkSchema(key, ['roles', role, 'grants', key]);
    }
  });

export type WardenConfig = z.infer<typeof wardenConfigSchema>;
export type TableConfig = z.infer<typeof tableConfigSchema>;
export type ColumnConfig = z.infer<typeof columnConfigSchema>;
export type RoleConfig = z.infer<typeof roleConfigSchema>;
export type Action = (typeof ACTIONS)[number];
