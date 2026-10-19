import type { Relation } from './effective-schema.js';
import type { Filter, Scalar } from './filter.js';

/**
 * Filter on `relation.entity` that selects the rows related to `row`: the parent for `belongsTo`,
 * the children for `hasMany`. Returns null when a key value is null (nothing is related) or isn't
 * a scalar the filter language can compare.
 */
export function relationFilter(relation: Relation, row: Record<string, unknown>): Filter | null {
  const conditions: Filter[] = [];
  for (const [i, column] of relation.columns.entries()) {
    const target = relation.targetColumns[i];
    const value = row[column];
    if (
      target === undefined ||
      (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
    ) {
      return null;
    }
    conditions.push({ field: target, op: 'eq', value: value satisfies Scalar });
  }
  if (conditions.length === 0) return null;
  return conditions.length === 1 ? conditions[0]! : { and: conditions };
}
