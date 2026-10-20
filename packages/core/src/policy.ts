// The schema entry point, not the package root: the root pulls in the Node-only file loader,
// and core also runs in the browser.
import { ACTIONS, type Action, type WardenConfig } from '@wardenhq/config/schema';
import type { EffectiveSchema, Entity, SchemaWarning } from './effective-schema.js';

export type { Action };

/** Who may do what to each entity, with config table keys resolved to entity keys. */
export interface Policy {
  /** Entity keys that exist. Anything else is denied every action. */
  entities: Set<string>;
  readByDefault: boolean;
  roles: Map<string, RoleGrants>;
  /** Per entity, actions nobody may perform. */
  denied: Map<string, Set<Action>>;
  /** Per entity and field, the roles that may read or write it, where config restricts them. */
  fields: Map<string, Map<string, FieldRule>>;
}

/** Roles a field is restricted to. A missing side means no restriction beyond the entity's. */
export interface FieldRule {
  readableBy?: Set<string>;
  writableBy?: Set<string>;
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

  const entities = new Map(schema.entities.map((e) => [e.key, e]));
  const fields = new Map<string, Map<string, FieldRule>>();
  for (const [tableKey, table] of Object.entries(config.tables)) {
    if (table.hidden) continue;
    const qualified = tableKey.includes('.') ? tableKey : `${defaultSchema}.${tableKey}`;
    const entity = entities.get(entityKeys.get(qualified) ?? '');
    // Missing tables and columns are already warned about by resolveSchema.
    if (!entity) continue;
    for (const [column, { readableBy, writableBy }] of Object.entries(table.columns)) {
      if (!readableBy && !writableBy) continue;
      if (!entity.fields.some((f) => f.name === column)) continue;
      const rule: FieldRule = {};
      if (readableBy) {
        // Record ids are built from the primary key, so it can't be hidden from anyone.
        if (entity.primaryKey.includes(column)) {
          warnings.push({
            path: `tables.${tableKey}.columns.${column}.readableBy`,
            message: 'primary key columns are readable by everyone who can read the table',
          });
        } else {
          rule.readableBy = new Set(readableBy);
        }
      }
      if (writableBy) rule.writableBy = new Set(writableBy);
      const byField = fields.get(entity.key) ?? new Map<string, FieldRule>();
      byField.set(column, rule);
      fields.set(entity.key, byField);
    }
  }

  return {
    policy: {
      entities: new Set(entityKeys.values()),
      readByDefault: config.defaults.read === 'all',
      roles,
      denied,
      fields,
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
  // Exporting is reading in bulk, so it needs read too.
  if (action === 'export' && !isAllowed(policy, roles, entity, 'read')) return false;
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

const holdsAny = (roles: readonly string[], allowed: Set<string> | undefined) =>
  allowed === undefined || roles.some((role) => allowed.has(role));

/** Whether `readableBy` lets `roles` read a field. Fields without a rule are readable. */
export const isFieldReadable = (
  policy: Policy,
  roles: readonly string[],
  entity: string,
  field: string,
): boolean => holdsAny(roles, policy.fields.get(entity)?.get(field)?.readableBy);

/**
 * The schema as someone holding `roles` sees it. Entities they may do nothing with are removed,
 * and so are fields they can't read, exactly as if config hid them; fields they can't write
 * become read-only. Everything that names a removed entity or field (search, default sort,
 * display field, relations) is adjusted to match, so every check that uses the result treats
 * them as nonexistent.
 *
 * An entity they may write but not read (say, create-only) stays, so they can fill in its form;
 * reading it is still denied.
 */
export function schemaFor(
  schema: EffectiveSchema,
  policy: Policy,
  roles: readonly string[],
): EffectiveSchema {
  const narrowed = new Map<string, Entity>();
  let changed = false;
  for (const entity of schema.entities) {
    if (allowedActions(policy, roles, entity.key).length === 0) {
      changed = true;
      continue;
    }
    const rules = policy.fields.get(entity.key);
    if (!rules) {
      narrowed.set(entity.key, entity);
      continue;
    }
    const readable = (field: string) => holdsAny(roles, rules.get(field)?.readableBy);
    const writable = (field: string) => holdsAny(roles, rules.get(field)?.writableBy);
    const fields = entity.fields
      .filter((f) => readable(f.name))
      .map((f) => (f.readOnly || writable(f.name) ? f : { ...f, readOnly: true }));
    const visible = new Set(fields.map((f) => f.name));
    if (fields.length === entity.fields.length && fields.every((f, i) => f === entity.fields[i])) {
      narrowed.set(entity.key, entity);
      continue;
    }
    changed = true;
    const { defaultSort, ...rest } = entity;
    narrowed.set(entity.key, {
      ...rest,
      fields,
      // Primary key columns are always readable.
      displayField: visible.has(entity.displayField)
        ? entity.displayField
        : (entity.primaryKey[0] ?? fields[0]?.name ?? ''),
      searchable: entity.searchable.filter((f) => visible.has(f)),
      ...(defaultSort && visible.has(defaultSort.column) ? { defaultSort } : {}),
    });
  }
  if (!changed) return schema;

  // A relation needs its target entity, and every key column on both sides, to be visible.
  const hasFields = (key: string, columns: string[]) => {
    const entity = narrowed.get(key);
    return entity !== undefined && columns.every((c) => entity.fields.some((f) => f.name === c));
  };
  return {
    entities: [...narrowed.values()].map((entity) => {
      const relations = entity.relations.filter(
        (r) => hasFields(entity.key, r.columns) && hasFields(r.entity, r.targetColumns),
      );
      return relations.length === entity.relations.length ? entity : { ...entity, relations };
    }),
  };
}
