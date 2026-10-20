import type { WardenConfig } from '@wardenhq/config/schema';
import { resolveSchema, type SchemaWarning } from './effective-schema.js';
import { resolvePolicy } from './policy.js';
import type { SchemaModel, Table } from './schema-model.js';

/** How Warden treats a column that config doesn't mention, per `defaults.newColumns`. */
export type ColumnTreatment = 'visible' | 'readOnly' | 'hidden';

/**
 * Differences between a baseline snapshot of the database and the current schema, limited to what
 * config doesn't already decide. Table keys use the same form as config keys.
 */
export interface SchemaDrift {
  /** New tables with no config entry, and whether Warden exposes them. */
  addedTables: { table: string; exposed: boolean }[];
  removedTables: { table: string }[];
  /** New columns with no config entry, on tables that are exposed. */
  addedColumns: { table: string; column: string; type: string; treatment: ColumnTreatment }[];
  /** Columns gone from tables that still exist and are exposed. */
  removedColumns: { table: string; column: string }[];
  /** Config that names tables or columns that don't exist or aren't exposed. */
  warnings: SchemaWarning[];
  /**
   * YAML for the config's `tables` that writes down how the added tables and columns are treated
   * now, so pasting it changes nothing until edited. Empty when nothing was added.
   */
  snippet: string;
}

export function diffSchema(
  baseline: SchemaModel,
  current: SchemaModel,
  config: WardenConfig,
): SchemaDrift {
  const defaultSchema = config.schemas[0] ?? 'public';
  const keyOf = (t: Table) => (t.schema === defaultSchema ? t.name : `${t.schema}.${t.name}`);
  const qualified = (t: Table) => `${t.schema}.${t.name}`;
  const configured = new Map(
    Object.entries(config.tables).map(([key, table]) => [
      key.includes('.') ? key : `${defaultSchema}.${key}`,
      table,
    ]),
  );

  const resolved = resolveSchema(current, config);
  const { warnings: policyWarnings } = resolvePolicy(resolved.schema, config);
  const entities = new Map(resolved.schema.entities.map((e) => [`${e.schema}.${e.name}`, e]));
  const before = new Map(baseline.tables.map((t) => [qualified(t), t]));
  const now = new Set(current.tables.map(qualified));

  const drift: SchemaDrift = {
    addedTables: [],
    removedTables: [],
    addedColumns: [],
    removedColumns: [],
    warnings: [...resolved.warnings, ...policyWarnings],
    snippet: '',
  };

  for (const table of current.tables) {
    const old = before.get(qualified(table));
    const entity = entities.get(qualified(table));
    if (!old) {
      if (!configured.has(qualified(table))) {
        drift.addedTables.push({ table: keyOf(table), exposed: entity !== undefined });
      }
      continue;
    }
    // Columns of tables nobody can see don't change what Warden shows.
    if (!entity) continue;

    const columnConfig = configured.get(qualified(table))?.columns ?? {};
    for (const column of table.columns) {
      if (old.columns.some((c) => c.name === column.name)) continue;
      if (Object.hasOwn(columnConfig, column.name)) continue;
      const field = entity.fields.find((f) => f.name === column.name);
      drift.addedColumns.push({
        table: keyOf(table),
        column: column.name,
        type: column.formattedType,
        treatment: !field ? 'hidden' : field.readOnly ? 'readOnly' : 'visible',
      });
    }
    for (const column of old.columns) {
      if (!table.columns.some((c) => c.name === column.name)) {
        drift.removedColumns.push({ table: keyOf(table), column: column.name });
      }
    }
  }
  for (const table of baseline.tables) {
    if (!now.has(qualified(table))) drift.removedTables.push({ table: keyOf(table) });
  }

  drift.snippet = driftSnippet(drift);
  return drift;
}

const SETTING: Record<ColumnTreatment, string> = {
  visible: '{ hidden: false }',
  readOnly: '{ readOnly: true }',
  hidden: '{ hidden: true }',
};

function driftSnippet({ addedTables, addedColumns }: SchemaDrift): string {
  if (addedTables.length === 0 && addedColumns.length === 0) return '';
  const lines = ['tables:'];
  for (const { table, exposed } of addedTables) {
    // An entry exposes the table even with `expose: none`, so unexposed tables must say hidden.
    lines.push(`  ${yamlKey(table)}: { hidden: ${!exposed} }`);
  }
  const byTable = new Map<string, typeof addedColumns>();
  for (const column of addedColumns) {
    byTable.set(column.table, [...(byTable.get(column.table) ?? []), column]);
  }
  for (const [table, columns] of byTable) {
    lines.push(`  ${yamlKey(table)}:`, '    columns:');
    for (const { column, treatment } of columns) {
      lines.push(`      ${yamlKey(column)}: ${SETTING[treatment]}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
// Plain scalars YAML 1.1 parsers would read as booleans or null.
const RESERVED = /^(y|n|yes|no|true|false|on|off|null)$/i;

/** Identifiers can hold any character, so quote anything that isn't a plain name. */
function yamlKey(key: string): string {
  // A JSON string is a valid YAML double-quoted scalar.
  return PLAIN_KEY.test(key) && !RESERVED.test(key) ? key : JSON.stringify(key);
}
