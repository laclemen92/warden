import type { Entity } from './effective-schema.js';

/** Creation/modification timestamp columns, in the order the grid shows them. */
export const TIMESTAMP_COLUMNS = [
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
  'inserted_at',
  'insertedAt',
  'modified_at',
  'modifiedAt',
] as const;

/**
 * Field names in the order the grid shows them. Configured `columnOrder` comes first; then the
 * primary key in key order, the display field, the timestamp columns, and everything else in
 * table order. Tables without a primary key keep table order after `columnOrder`.
 */
export function gridColumnOrder(entity: Entity): string[] {
  const names = entity.fields.map((f) => f.name);
  const exists = new Set(names);
  const order: string[] = [];
  const add = (name: string) => {
    if (exists.has(name) && !order.includes(name)) order.push(name);
  };

  entity.columnOrder?.forEach(add);
  if (entity.primaryKey.length > 0) {
    entity.primaryKey.forEach(add);
    add(entity.displayField);
    TIMESTAMP_COLUMNS.forEach(add);
  }
  names.forEach(add);
  return order;
}
