import type { Column, EnumType, ForeignKey, SchemaModel, Table } from '@wardenhq/core';
import type { Pool, PoolClient } from 'pg';

/** Schema holding Warden's own metadata (sessions, audit log). Never introspected. */
export const WARDEN_SCHEMA = 'warden';

export interface IntrospectOptions {
  /** Schemas to introspect. Defaults to `['public']`. */
  schemas?: string[];
}

/**
 * Read tables, columns, keys, and enums from Postgres system catalogs.
 *
 * All queries run in one read-only, repeatable-read transaction so the result is a consistent
 * snapshot even if DDL runs concurrently.
 */
export async function introspect(
  pool: Pool,
  { schemas = ['public'] }: IntrospectOptions = {},
): Promise<SchemaModel> {
  const targetSchemas = schemas.filter(
    (s) => s !== WARDEN_SCHEMA && s !== 'information_schema' && !s.startsWith('pg_'),
  );

  const client = await pool.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    const model = await readModel(client, targetSchemas);
    await client.query('commit');
    return model;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface TableRow {
  oid: string;
  schema: string;
  name: string;
  relkind: 'r' | 'p';
  comment: string | null;
}

interface ColumnRow {
  table_oid: string;
  name: string;
  data_type: string;
  formatted_type: string;
  is_array: boolean;
  nullable: boolean;
  has_default: boolean;
  identity: '' | 'a' | 'd';
  generated: boolean;
  enum_oid: string | null;
  enum_schema: string | null;
  comment: string | null;
}

interface ConstraintRow {
  table_oid: string;
  name: string;
  contype: 'p' | 'f';
  columns: string[];
  ref_schema: string | null;
  ref_table: string | null;
  ref_columns: string[] | null;
}

interface UniqueRow {
  table_oid: string;
  columns: string[];
}

interface EnumRow {
  schema: string;
  name: string;
  values: string[];
}

// Ordered column names for a constraint/index key array, resolved against `rel`.
const keyColumns = (keys: string, rel: string, extraFilter = '') => `
  array(
    select a.attname::text
    from unnest(${keys}) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = ${rel} and a.attnum = k.attnum
    ${extraFilter}
    order by k.ord
  )`;

const TABLES_SQL = `
  select c.oid::int8::text as oid, n.nspname as schema, c.relname as name, c.relkind,
         obj_description(c.oid, 'pg_class') as comment
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and not c.relispartition and n.nspname = any($1)
  order by n.nspname, c.relname`;

const COLUMNS_SQL = `
  select a.attrelid::int8::text as table_oid,
         a.attname as name,
         coalesce(et.typname, t.typname) as data_type,
         format_type(a.atttypid, a.atttypmod) as formatted_type,
         et.oid is not null as is_array,
         not a.attnotnull as nullable,
         (a.atthasdef or a.attidentity <> '' or a.attgenerated <> '') as has_default,
         a.attidentity::text as identity,
         a.attgenerated <> '' as generated,
         case when coalesce(et.typtype, t.typtype) = 'e'
              then coalesce(et.oid, t.oid)::int8::text end as enum_oid,
         case when coalesce(et.typtype, t.typtype) = 'e' then tn.nspname end as enum_schema,
         col_description(a.attrelid, a.attnum) as comment
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  left join pg_type et on t.typcategory = 'A' and et.oid = t.typelem
  join pg_namespace tn on tn.oid = coalesce(et.typnamespace, t.typnamespace)
  where c.relkind in ('r', 'p') and not c.relispartition and n.nspname = any($1)
    and a.attnum > 0 and not a.attisdropped
  order by a.attrelid, a.attnum`;

const CONSTRAINTS_SQL = `
  select con.conrelid::int8::text as table_oid, con.conname as name, con.contype,
         ${keyColumns('con.conkey', 'con.conrelid')} as columns,
         rn.nspname as ref_schema, rc.relname as ref_table,
         case when con.contype = 'f' then ${keyColumns('con.confkey', 'con.confrelid')} end as ref_columns
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_class rc on rc.oid = con.confrelid
  left join pg_namespace rn on rn.oid = rc.relnamespace
  where con.contype in ('p', 'f') and n.nspname = any($1)
  order by con.conrelid, con.conname`;

// Unique indexes (including those backing UNIQUE constraints) that identify a row:
// no partial predicate, no expressions, key columns only (INCLUDE columns excluded).
const UNIQUE_SQL = `
  select i.indrelid::int8::text as table_oid,
         ${keyColumns('i.indkey::int2[]', 'i.indrelid', 'where k.ord <= i.indnkeyatts')} as columns
  from pg_index i
  join pg_class c on c.oid = i.indrelid
  join pg_class ic on ic.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where i.indisunique and not i.indisprimary and i.indpred is null and i.indexprs is null
    and n.nspname = any($1)
  order by i.indrelid, ic.relname`;

// Enums in the target schemas, plus any enum referenced by a column even if it lives elsewhere.
const ENUMS_SQL = `
  select n.nspname as schema, t.typname as name,
         array_agg(e.enumlabel::text order by e.enumsortorder) as values
  from pg_type t
  join pg_enum e on e.enumtypid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = any($1) or t.oid::int8 = any($2::int8[])
  group by n.nspname, t.typname
  order by n.nspname, t.typname`;

async function readModel(client: PoolClient, schemas: string[]): Promise<SchemaModel> {
  const tables = await client.query<TableRow>(TABLES_SQL, [schemas]);
  const columns = await client.query<ColumnRow>(COLUMNS_SQL, [schemas]);
  const constraints = await client.query<ConstraintRow>(CONSTRAINTS_SQL, [schemas]);
  const uniques = await client.query<UniqueRow>(UNIQUE_SQL, [schemas]);

  const enumOids = [...new Set(columns.rows.flatMap((c) => (c.enum_oid ? [c.enum_oid] : [])))];
  const enums = await client.query<EnumRow>(ENUMS_SQL, [schemas, enumOids]);

  const enumNameByOid = new Map<string, { schema: string; name: string }>();
  for (const c of columns.rows) {
    if (c.enum_oid && c.enum_schema) {
      enumNameByOid.set(c.enum_oid, { schema: c.enum_schema, name: c.data_type });
    }
  }

  const byOid = new Map<string, Table>();
  for (const row of tables.rows) {
    const table: Table = {
      schema: row.schema,
      name: row.name,
      kind: row.relkind === 'p' ? 'partitioned' : 'table',
      columns: [],
      primaryKey: [],
      uniqueKeys: [],
      foreignKeys: [],
    };
    if (row.comment) table.comment = row.comment;
    byOid.set(row.oid, table);
  }

  for (const row of columns.rows) {
    byOid.get(row.table_oid)?.columns.push(toColumn(row, enumNameByOid));
  }

  for (const row of constraints.rows) {
    const table = byOid.get(row.table_oid);
    if (!table) continue;
    if (row.contype === 'p') {
      table.primaryKey = row.columns;
    } else if (row.ref_schema && row.ref_table && row.ref_columns) {
      const fk: ForeignKey = {
        name: row.name,
        columns: row.columns,
        references: { schema: row.ref_schema, name: row.ref_table, columns: row.ref_columns },
      };
      table.foreignKeys.push(fk);
    }
  }

  for (const row of uniques.rows) {
    byOid.get(row.table_oid)?.uniqueKeys.push(row.columns);
  }

  return {
    tables: [...byOid.values()],
    enums: enums.rows.map((r): EnumType => ({ schema: r.schema, name: r.name, values: r.values })),
  };
}

function toColumn(
  row: ColumnRow,
  enumNameByOid: Map<string, { schema: string; name: string }>,
): Column {
  const column: Column = {
    name: row.name,
    dataType: row.data_type,
    formattedType: row.formatted_type,
    isArray: row.is_array,
    nullable: row.nullable,
    hasDefault: row.has_default,
    generated: row.generated,
  };
  if (row.identity === 'a') column.identity = 'always';
  if (row.identity === 'd') column.identity = 'byDefault';
  const enumName = row.enum_oid ? enumNameByOid.get(row.enum_oid) : undefined;
  if (enumName) column.enum = enumName;
  if (row.comment) column.comment = row.comment;
  return column;
}
