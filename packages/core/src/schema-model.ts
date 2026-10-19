/** Normalized description of a database, produced by an adapter's introspection. */
export interface SchemaModel {
  tables: Table[];
  enums: EnumType[];
}

export interface Table {
  schema: string;
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
}

export interface Column {
  name: string;
  /** Database-native type name, e.g. `text`, `int4`, `timestamptz`. */
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  /** Set when the column uses an enum type. */
  enumName?: string;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  references: { schema: string; table: string; columns: string[] };
}

export interface EnumType {
  schema: string;
  name: string;
  values: string[];
}

export function getTable(model: SchemaModel, name: string, schema = 'public'): Table | undefined {
  return model.tables.find((t) => t.name === name && t.schema === schema);
}
