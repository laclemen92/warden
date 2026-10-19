import type { Filter, Scalar } from '@wardenhq/core';
import { sql, type Expression, type SqlBool } from 'kysely';

/**
 * Compile a filter to a parameterized SQL boolean expression.
 *
 * Only pass filters that came from `validateFilter`: it guarantees fields exist on the entity and
 * values fit their columns. Field names are still quoted with `sql.id` and every value is a bind
 * parameter, so nothing from the filter is ever interpolated into SQL text.
 *
 * Pass `table` to qualify column references (e.g. when the query joins other tables).
 */
export function compileFilter(filter: Filter, table?: string): Expression<SqlBool> {
  const recurse = (f: Filter) => compileFilter(f, table);
  if ('and' in filter) return sql<SqlBool>`(${sql.join(filter.and.map(recurse), sql` and `)})`;
  if ('or' in filter) return sql<SqlBool>`(${sql.join(filter.or.map(recurse), sql` or `)})`;
  if ('not' in filter) return sql<SqlBool>`not ${recurse(filter.not)}`;

  const column = table ? sql.id(table, filter.field) : sql.id(filter.field);
  const list = (values: Scalar[]) => sql.join(values.map((v) => sql.val(v)));

  switch (filter.op) {
    case 'eq':
      return sql<SqlBool>`${column} = ${filter.value}`;
    // neq/notIn include NULLs: "status is not paid" should match rows with no status.
    case 'neq':
      return sql<SqlBool>`${column} is distinct from ${filter.value}`;
    case 'in':
      return sql<SqlBool>`${column} in (${list(filter.value)})`;
    case 'notIn':
      return sql<SqlBool>`(${column} is null or ${column} not in (${list(filter.value)}))`;
    case 'gt':
      return sql<SqlBool>`${column} > ${filter.value}`;
    case 'gte':
      return sql<SqlBool>`${column} >= ${filter.value}`;
    case 'lt':
      return sql<SqlBool>`${column} < ${filter.value}`;
    case 'lte':
      return sql<SqlBool>`${column} <= ${filter.value}`;
    case 'between':
      return sql<SqlBool>`${column} between ${filter.value[0]} and ${filter.value[1]}`;
    case 'contains':
      return sql<SqlBool>`${column} ilike ${`%${escapeLike(filter.value)}%`}`;
    case 'startsWith':
      return sql<SqlBool>`${column} ilike ${`${escapeLike(filter.value)}%`}`;
    case 'endsWith':
      return sql<SqlBool>`${column} ilike ${`%${escapeLike(filter.value)}`}`;
    case 'isNull':
      return sql<SqlBool>`${column} is null`;
    case 'isNotNull':
      return sql<SqlBool>`${column} is not null`;
  }
}

/** Escape LIKE wildcards so user input matches literally (Postgres' default escape is `\`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
