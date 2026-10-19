// The schema entry point, not the package root: the root pulls in the Node-only file loader,
// and core also runs in the browser.
import { ACTIONS, type Action, type WardenConfig } from '@wardenhq/config/schema';
import type { EffectiveSchema, SchemaWarning } from './effective-schema.js';

export type { Action };

/** Who may do what to each entity, with config table keys resolved to entity keys. */
export interface Policy {
  /** Entity keys that exist. Anything else is denied every action. */
  entities: Set<string>;
  readByDefault: boolean;
  roles: Map<string, RoleGrants>;
  /** Per entity, actions nobody may perform. */
  denied: Map<string, Set<Action>>;
}

interface RoleGrants {
  everywhere: Set<Action>;
  byEntity: Map<string, Set<Action>>;
}

export interface ResolvedPolicy {
  policy: Policy;
  warnings: SchemaWarning[];
}

/**
 * Build a policy for an effective schema. Grants and denies that name tables which aren't exposed
 * become warnings, like any other config/DB mismatch.
 */
export function resolvePolicy(schema: EffectiveSchema, config: WardenConfig): ResolvedPolicy {
  const warnings: SchemaWarning[] = [];
  const defaultSchema = config.schemas[0] ?? 'public';
  const entityKeys = new Map(schema.entities.map((e) => [`${e.schema}.${e.name}`, e.key]));
  const entityKey = (tableKey: string, path: string) => {
    const qualified = tableKey.includes('.') ? tableKey : `${defaultSchema}.${tableKey}`;
    const key = entityKeys.get(qualified);
    if (!key) warnings.push({ path, message: `table "${qualified}" is not exposed` });
    return key;
  };

  const roles = new Map<string, RoleGrants>();
  for (const [role, { grants }] of Object.entries(config.roles)) {
    const resolved: RoleGrants = { everywhere: new Set(), byEntity: new Map() };
    for (const [tableKey, actions] of Object.entries(grants)) {
      if (tableKey === '*') {
        actions.forEach((a) => resolved.everywhere.add(a));
        continue;
      }
      const key = entityKey(tableKey, `roles.${role}.grants.${tableKey}`);
      if (key) addAll(resolved.byEntity, key, actions);
    }
    roles.set(role, resolved);
  }

  const denied = new Map<string, Set<Action>>();
  for (const [tableKey, table] of Object.entries(config.tables)) {
    // Hidden tables are already inaccessible, and resolveSchema warns about missing ones.
    if (!table.deny || table.hidden) continue;
    const key = entityKey(tableKey, `tables.${tableKey}.deny`);
    if (key) addAll(denied, key, table.deny);
  }

  return {
    policy: {
      entities: new Set(entityKeys.values()),
      readByDefault: config.defaults.read === 'all',
      roles,
      denied,
    },
    warnings,
  };
}

/**
 * Whether someone holding `roles` may perform `action` on `entity`. Roles combine (any grant
 * allows), a table-level deny beats every grant, and unknown entities or roles grant nothing.
 */
export function isAllowed(
  policy: Policy,
  roles: readonly string[],
  entity: string,
  action: Action,
): boolean {
  if (!policy.entities.has(entity)) return false;
  if (policy.denied.get(entity)?.has(action)) return false;
  if (action === 'read' && policy.readByDefault) return true;
  return roles.some((role) => {
    const grants = policy.roles.get(role);
    return (
      grants !== undefined &&
      (grants.everywhere.has(action) || grants.byEntity.get(entity)?.has(action) === true)
    );
  });
}

/** Every action `roles` may perform on `entity`, in canonical order. */
export function allowedActions(policy: Policy, roles: readonly string[], entity: string): Action[] {
  return ACTIONS.filter((action) => isAllowed(policy, roles, entity, action));
}

function addAll(map: Map<string, Set<Action>>, key: string, actions: readonly Action[]) {
  const set = map.get(key) ?? new Set<Action>();
  actions.forEach((a) => set.add(a));
  map.set(key, set);
}
