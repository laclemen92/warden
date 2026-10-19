import type { Entity, Field } from '@wardenhq/core';

function field(name: string, label: string, dataType: string, extra: Partial<Field> = {}): Field {
  return {
    name,
    label,
    dataType,
    formattedType: dataType,
    isArray: false,
    nullable: true,
    hasDefault: false,
    readOnly: false,
    ...extra,
  };
}

/** One field of each filterable kind. */
export const orders: Entity = {
  key: 'orders',
  schema: 'public',
  name: 'orders',
  kind: 'table',
  label: 'Orders',
  primaryKey: ['id'],
  displayField: 'id',
  defaultSort: { column: 'placed_at', direction: 'desc' },
  searchable: ['notes'],
  fields: [
    field('id', 'Id', 'int8', { nullable: false }),
    field('status', 'Status', 'order_status', {
      enumValues: ['pending', 'paid', 'shipped'],
    }),
    field('total', 'Total', 'numeric'),
    field('notes', 'Notes', 'text'),
    field('is_gift', 'Gift', 'bool'),
    field('placed_at', 'Placed at', 'timestamptz'),
    field('ship_by', 'Ship by', 'date'),
    field('metadata', 'Metadata', 'jsonb'),
  ],
  relations: [],
};

export const fieldOf = (entity: Entity, name: string): Field => {
  const f = entity.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
};
