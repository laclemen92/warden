import { schemaFor, type EffectiveSchema, type Entity, type Policy } from '@wardenhq/core';

export interface SchemaView {
  schema: EffectiveSchema;
  entities: Map<string, Entity>;
}

/**
 * The schema as each set of roles sees it (field-level read and write rules applied), cached
 * per set. Roles come from config, so there are only ever a handful of sets.
 */
export function createViews(schema: EffectiveSchema, policy: Policy) {
  const cache = new Map<string, SchemaView>();
  return (roles: readonly string[] | null): SchemaView => {
    const sorted = [...(roles ?? [])].sort();
    const key = JSON.stringify(sorted);
    let view = cache.get(key);
    if (!view) {
      const narrowed = schemaFor(schema, policy, sorted);
      view = { schema: narrowed, entities: new Map(narrowed.entities.map((e) => [e.key, e])) };
      cache.set(key, view);
    }
    return view;
  };
}

export type Views = ReturnType<typeof createViews>;
