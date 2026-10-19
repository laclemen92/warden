import type { Entity, FieldError } from '@wardenhq/core';
import { sql } from 'kysely';
import type { Database } from './database.js';

export interface WriteErrorResult {
  /** 409 when the write conflicts with other rows (unique, exclusion, still referenced). */
  status: 400 | 409;
  errors: FieldError[];
}

interface PgError {
  code: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

const isPgError = (err: unknown): err is PgError =>
  typeof err === 'object' && err !== null && typeof (err as PgError).code === 'string';

// Data errors don't say which column they came from. Messages are fixed so the error can't echo
// anything from the database.
const DATA_ERRORS: Record<string, string> = {
  '22001': 'a value is too long for its field',
  '22003': 'a number is out of range for its field',
  '22007': 'a date/time value has an invalid format',
  '22008': 'a date/time value is out of range',
  '22021': 'a value contains invalid characters',
  '22P02': 'a value has an invalid format',
  '22P05': 'a value contains invalid characters',
};

// Columns of a constraint on the table, or of a unique index (which may have no constraint).
// Null when an index key is an expression, since then no set of columns explains the violation.
const CONSTRAINT_COLUMNS_SQL = (schema: string, table: string, name: string) => sql<{
  columns: string[] | null;
}>`
  select coalesce(
    (select array(
       select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
       order by k.ord)
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = ${schema} and c.relname = ${table} and con.conname = ${name}
       and con.conkey is not null),
    (select case when 0 = any(i.indkey::int2[]) then null else array(
       select a.attname::text from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
       where k.ord <= i.indnkeyatts
       order by k.ord) end
     from pg_index i
     join pg_class ic on ic.oid = i.indexrelid
     join pg_class c on c.oid = i.indrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = ${schema} and c.relname = ${table} and ic.relname = ${name})
  ) as columns`;

/**
 * Translate a Postgres error from a write on `entity` into field errors, or return undefined if
 * it isn't a constraint or data error (the caller should treat it as a 500).
 *
 * Only fields the entity exposes are named: a violation involving a hidden column is reported
 * against the record as a whole so the column's existence doesn't leak. Call this after the
 * failed transaction has ended; it may query the catalog.
 */
export async function mapWriteError(
  db: Database,
  entity: Entity,
  err: unknown,
  operation: 'create' | 'update' | 'delete',
): Promise<WriteErrorResult | undefined> {
  if (!isPgError(err)) return undefined;
  const visible = new Set(entity.fields.map((f) => f.name));
  const onEntity = err.schema === entity.schema && err.table === entity.name;

  const constraintColumns = async () => {
    if (!onEntity || !err.constraint) return undefined;
    const { rows } = await CONSTRAINT_COLUMNS_SQL(
      entity.schema,
      entity.name,
      err.constraint,
    ).execute(db);
    const columns = rows[0]?.columns;
    return columns && columns.length > 0 && columns.every((c) => visible.has(c))
      ? columns
      : undefined;
  };
  const perField = (columns: string[], message: (column: string) => string) =>
    columns.map((field) => ({ field, message: message(field) }));
  const others = (columns: string[], column: string) =>
    columns.filter((c) => c !== column).join(', ');

  const dataError = DATA_ERRORS[err.code];
  if (dataError) return { status: 400, errors: [{ message: dataError }] };

  switch (err.code) {
    case '23502': {
      // not_null_violation
      const field = onEntity && err.column && visible.has(err.column) ? err.column : undefined;
      return {
        status: 400,
        errors: [
          field ? { field, message: 'is required' } : { message: 'a required value is missing' },
        ],
      };
    }
    case '23505':
    case '23P01': {
      // unique_violation, exclusion_violation
      const columns = await constraintColumns();
      const message =
        err.code === '23505' ? 'is already in use' : 'conflicts with an existing record';
      return {
        status: 409,
        errors: columns
          ? perField(columns, (c) =>
              columns.length > 1 ? `${message} together with ${others(columns, c)}` : message,
            )
          : [{ message: 'conflicts with an existing record' }],
      };
    }
    case '23503':
    case '23001': {
      // foreign_key_violation, restrict_violation. Postgres reports both sides of a foreign key
      // against the referencing table, so a delete (or a write to another table) means this row
      // is still referenced; otherwise the row references something missing.
      if (err.code === '23001' || operation === 'delete' || !onEntity) {
        return { status: 409, errors: [{ message: 'is referenced by other records' }] };
      }
      const columns = await constraintColumns();
      return {
        status: 400,
        errors: columns
          ? perField(columns, () => 'references a record that does not exist')
          : [{ message: 'references a record that does not exist' }],
      };
    }
    case '23514': {
      // check_violation
      const columns = await constraintColumns();
      return {
        status: 400,
        errors: columns
          ? perField(columns, () => `violates check constraint "${err.constraint}"`)
          : [{ message: 'violates a check constraint' }],
      };
    }
    default:
      return undefined;
  }
}
