import type { TableConfig, WardenConfig, WriteAction } from '@wardenhq/config';
import { WRITE_ACTIONS } from '@wardenhq/config/schema';
import type { Column, SchemaModel, Table } from './schema-model.js';

/**
 * What Warden exposes: the introspected schema narrowed and customized by config.
 * Hidden tables and columns are absent entirely, so this is safe to send to the UI.
 */
export interface EffectiveSchema {
  entities: Entity[];
}

export interface Entity {
  /** Stable id used in URLs and config: `table` in the default schema, otherwise `schema.table`. */
  key: string;
  schema: string;
  name: string;
  kind: Table['kind'];
  label: string;
  comment?: string;
  /** Empty when the table has no primary key (rows can be listed but not addressed). */
  primaryKey: string[];
  /** Field used to represent a row elsewhere (FK links, pickers). */
  displayField: string;
  defaultSort?: { column: string; direction: 'asc' | 'desc' };
  searchable: string[];
  /** Writes that must give a reason (stored in the audit log); absent when none must. */
  requireReason?: WriteAction[];
  fields: Field[];
  relations: Relation[];
}

export interface Field {
  name: string;
  label: string;
  dataType: string;
  formattedType: string;
  isArray: boolean;
  nullable: boolean;
  hasDefault: boolean;
  /** Never writable: configured read-only, identity `always`, or generated. */
  readOnly: boolean;
  /**
   * Writable on create but not on update: primary key columns, unless the table sets
   * `updatablePrimaryKey`. Present only when true. See `entityFor`.
   */
  createOnly?: true;
  /** Column constraints that write validation enforces; see `Column`. */
  maxLength?: number;
  precision?: number;
  scale?: number;
  enumValues?: string[];
  comment?: string;
}

export interface Relation {
  /** `belongsTo`: this entity holds the FK. `hasMany`: the other entity references this one. */
  kind: 'belongsTo' | 'hasMany';
  /** Foreign key constraint name. */
  name: string;
  /** Key of the related entity. */
  entity: string;
  /** Columns on this entity, positionally matched to `targetColumns`. */
  columns: string[];
  targetColumns: string[];
}

export interface SchemaWarning {
  /** Config key path the warning refers to, e.g. `tables.users.columns.nickname`. */
  path: string;
  message: string;
}

export interface ResolvedSchema {
  schema: EffectiveSchema;
  warnings: SchemaWarning[];
}

const DISPLAY_FIELD_CANDIDATES = ['name', 'title', 'label', 'display_name', 'username', 'email'];
const TEXT_TYPES = new Set(['text', 'varchar', 'bpchar', 'citext']);

/**
 * Apply config to an introspected schema. Never throws on config that doesn't match the database:
 * unknown references become warnings so a schema change can't take the backoffice down. Throws
 * only when two exposed tables would get the same entity key.
 */
export function resolveSchema(model: SchemaModel, config: WardenConfig): ResolvedSchema {
  const warnings: SchemaWarning[] = [];
  const warn = (path: string, message: string) => warnings.push({ path, message });
  const defaultSchema = config.schemas[0] ?? 'public';
  const keyOf = (t: { schema: string; name: string }) =>
    t.schema === defaultSchema ? t.name : `${t.schema}.${t.name}`;

  // Match config keys to tables; "users" and "public.users" are the same table, and config
  // validation rejects listing both.
  const tableConfigs = new Map<string, { path: string; config: TableConfig }>();
  for (const [key, tableConfig] of Object.entries(config.tables)) {
    const qualified = key.includes('.') ? key : `${defaultSchema}.${key}`;
    const path = `tables.${key}`;
    if (!model.tables.some((t) => `${t.schema}.${t.name}` === qualified)) {
      warn(path, `table "${qualified}" does not exist`);
    } else {
      tableConfigs.set(qualified, { path, config: tableConfig });
    }
  }

  const enumValues = new Map(model.enums.map((e) => [`${e.schema}.${e.name}`, e.values]));
  const exposedTables: Table[] = [];
  const entities: Entity[] = [];

  for (const table of model.tables) {
    const configured = tableConfigs.get(`${table.schema}.${table.name}`);
    const exposed = configured ? !configured.config.hidden : config.defaults.expose === 'all';
    if (!exposed) continue;

    const path = configured?.path ?? `tables.${keyOf(table)}`;
    const tableConfig = configured?.config;
    const fields = resolveFields(table, tableConfig, config, path, warn, enumValues);
    const visible = new Set(fields.map((f) => f.name));

    // References to columns that don't exist or aren't visible are dropped with a warning.
    const usable = (column: string, keyPath: string) => {
      if (visible.has(column)) return true;
      const exists = table.columns.some((c) => c.name === column);
      warn(keyPath, `column "${column}" ${exists ? 'is not visible' : 'does not exist'}`);
      return false;
    };

    const entity: Entity = {
      key: keyOf(table),
      schema: table.schema,
      name: table.name,
      kind: table.kind,
      label: tableConfig?.label ?? humanize(table.name),
      primaryKey: table.primaryKey,
      displayField:
        tableConfig?.displayField && usable(tableConfig.displayField, `${path}.displayField`)
          ? tableConfig.displayField
          : defaultDisplayField(table, fields),
      searchable: tableConfig?.searchable
        ? tableConfig.searchable.filter((c, i) => usable(c, `${path}.searchable.${i}`))
        : fields.filter((f) => TEXT_TYPES.has(f.dataType) && !f.isArray).map((f) => f.name),
      fields,
      relations: [],
    };
    if (table.comment) entity.comment = table.comment;
    if (tableConfig?.requireReason?.length) {
      // Canonical order, without duplicates.
      const required = new Set(tableConfig.requireReason);
      entity.requireReason = WRITE_ACTIONS.filter((a) => required.has(a));
    }
    const sort = tableConfig?.defaultSort;
    if (sort && usable(sort.column, `${path}.defaultSort.column`)) entity.defaultSort = sort;

    exposedTables.push(table);
    entities.push(entity);
  }

  // A table named "a.b" in the default schema and table "b" in schema "a" would share key "a.b",
  // and grants, denies, and routes for one would reach the other. Neither can be configured
  // apart from the other, so refuse to start rather than guess.
  const byKey = new Map<string, Entity>();
  for (const entity of entities) {
    const other = byKey.get(entity.key);
    if (other) {
      throw new Error(
        `tables "${other.schema}"."${other.name}" and "${entity.schema}"."${entity.name}" ` +
          `both have the key "${entity.key}"; rename one, or set \`defaults.expose: none\` and ` +
          'list the tables to expose',
      );
    }
    byKey.set(entity.key, entity);
  }

  // Relations only link exposed entities through visible columns.
  const entityByTable = new Map(
    exposedTables.map((t, i) => [`${t.schema}.${t.name}`, entities[i]!]),
  );
  const isVisible = (entity: Entity, columns: string[]) =>
    columns.every((c) => entity.fields.some((f) => f.name === c));

  for (const table of exposedTables) {
    const source = entityByTable.get(`${table.schema}.${table.name}`)!;
    for (const fk of table.foreignKeys) {
      const target = entityByTable.get(`${fk.references.schema}.${fk.references.name}`);
      if (!target || !isVisible(source, fk.columns) || !isVisible(target, fk.references.columns)) {
        continue;
      }
      source.relations.push({
        kind: 'belongsTo',
        name: fk.name,
        entity: target.key,
        columns: fk.columns,
        targetColumns: fk.references.columns,
      });
      target.relations.push({
        kind: 'hasMany',
        name: fk.name,
        entity: source.key,
        columns: fk.references.columns,
        targetColumns: fk.columns,
      });
    }
  }

  return { schema: { entities }, warnings };
}

function resolveFields(
  table: Table,
  tableConfig: TableConfig | undefined,
  config: WardenConfig,
  path: string,
  warn: (path: string, message: string) => void,
  enumValues: Map<string, string[]>,
): Field[] {
  const { newColumns } = config.defaults;

  for (const name of Object.keys(tableConfig?.columns ?? {})) {
    if (!table.columns.some((c) => c.name === name)) {
      warn(`${path}.columns.${name}`, `column "${name}" does not exist`);
    }
  }

  const fields: Field[] = [];
  for (const column of table.columns) {
    const columnConfig = tableConfig?.columns[column.name];
    const isPrimaryKey = table.primaryKey.includes(column.name);
    let hidden = columnConfig ? columnConfig.hidden === true : newColumns === 'hidden';

    // Rows are addressed by primary key, so it always stays visible.
    if (hidden && isPrimaryKey) {
      if (columnConfig?.hidden) {
        warn(`${path}.columns.${column.name}`, 'primary key columns cannot be hidden');
      }
      hidden = false;
    }
    if (hidden) continue;

    const field = toField(column, columnConfig, newColumns, enumValues);
    if (isPrimaryKey && !field.readOnly && !tableConfig?.updatablePrimaryKey) {
      field.createOnly = true;
    }
    fields.push(field);
  }
  return fields;
}

/**
 * The entity as a write in `mode` sees it: on update, create-only fields are read-only. Write
 * validation and the UI's forms both go through this, so they agree.
 */
export function entityFor(entity: Entity, mode: 'create' | 'update'): Entity {
  if (mode === 'create' || !entity.fields.some((f) => f.createOnly)) return entity;
  return {
    ...entity,
    fields: entity.fields.map((f) => (f.createOnly ? { ...f, readOnly: true } : f)),
  };
}

function toField(
  column: Column,
  columnConfig: TableConfig['columns'][string] | undefined,
  newColumns: WardenConfig['defaults']['newColumns'],
  enumValues: Map<string, string[]>,
): Field {
  const configuredReadOnly = columnConfig
    ? columnConfig.readOnly === true
    : newColumns === 'readOnly';
  const field: Field = {
    name: column.name,
    label: columnConfig?.label ?? humanize(column.name),
    dataType: column.dataType,
    formattedType: column.formattedType,
    isArray: column.isArray,
    nullable: column.nullable,
    hasDefault: column.hasDefault,
    readOnly: configuredReadOnly || column.identity === 'always' || column.generated,
  };
  if (column.maxLength !== undefined) field.maxLength = column.maxLength;
  if (column.precision !== undefined) field.precision = column.precision;
  if (column.scale !== undefined) field.scale = column.scale;
  const values = column.enum && enumValues.get(`${column.enum.schema}.${column.enum.name}`);
  if (values) field.enumValues = values;
  if (column.comment) field.comment = column.comment;
  return field;
}

function defaultDisplayField(table: Table, fields: Field[]): string {
  const visible = new Set(fields.map((f) => f.name));
  for (const candidate of DISPLAY_FIELD_CANDIDATES) {
    if (visible.has(candidate)) return candidate;
  }
  const uniqueText = table.uniqueKeys.find(
    (key) =>
      key.length === 1 && fields.some((f) => f.name === key[0] && TEXT_TYPES.has(f.dataType)),
  );
  return uniqueText?.[0] ?? table.primaryKey[0] ?? fields[0]?.name ?? '';
}

/** `full_name` → `Full name`, `orderItems` → `Order items`. */
export function humanize(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
