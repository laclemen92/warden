import { z } from 'zod';

// Roles, grants, and per-table `deny` land in #28.

const name = z.string().min(1);

/** `table` (resolved against the first entry in `schemas`) or `schema.table`. */
const tableKey = z.string().regex(/^[^.]+(\.[^.]+)?$/, 'Expected "table" or "schema.table"');

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
      })
      .prefault({}),
    tables: z.record(tableKey, tableConfigSchema).default({}),
  })
  .superRefine((config, ctx) => {
    for (const key of Object.keys(config.tables)) {
      const [schema] = key.split('.');
      if (key.includes('.') && schema && !config.schemas.includes(schema)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tables', key],
          message: `schema "${schema}" is not listed in \`schemas\``,
        });
      }
    }
  });

export type WardenConfig = z.infer<typeof wardenConfigSchema>;
export type TableConfig = z.infer<typeof tableConfigSchema>;
export type ColumnConfig = z.infer<typeof columnConfigSchema>;
