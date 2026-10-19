/** Normalized description of a database, produced by an adapter's introspection. */
export interface SchemaModel {
  tables: Table[];
  enums: EnumType[];
}

export interface QualifiedName {
  schema: string;
  name: string;
}

export interface Table extends QualifiedName {
  /** `partitioned` tables are queried like regular tables. */
  kind: 'table' | 'partitioned';
  comment?: string;
  /** Columns in ordinal position order. */
  columns: Column[];
  /** Primary key column names in key order; empty when the table has no primary key. */
  primaryKey: string[];
  /** Column sets covered by unique constraints (excluding the primary key). */
  uniqueKeys: string[][];
  foreignKeys: ForeignKey[];
}

export interface Column {
  name: string;
  /** Base type name as known to the database, e.g. `text`, `int4`, `timestamptz`. For arrays, the element type. */
  dataType: string;
  /** Full type as the database formats it, e.g. `numeric(12,2)`, `character(3)`, `text[]`. */
  formattedType: string;
  isArray: boolean;
  nullable: boolean;
  /** True when inserts may omit the column (has a default, identity, or is generated). */
  hasDefault: boolean;
  /** Identity column kind; `always` columns cannot be written. */
  identity?: 'always' | 'byDefault';
  /** Generated (computed) columns cannot be written. */
  generated: boolean;
  /** Set when the column (or its array element) is an enum type. */
  enum?: QualifiedName;
  comment?: string;
}

export interface ForeignKey {
  name: string;
  /** Local columns, positionally matched to `references.columns`. */
  columns: string[];
  references: QualifiedName & { columns: string[] };
}

export interface EnumType extends QualifiedName {
  /** Values in declaration order. */
  values: string[];
}

export function getTable(model: SchemaModel, name: string, schema = 'public'): Table | undefined {
  return model.tables.find((t) => t.name === name && t.schema === schema);
}
