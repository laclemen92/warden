import type { WardenConfig, WriteAction } from '@wardenhq/config';
import { ACTION_NAME, WRITE_ACTIONS } from '@wardenhq/config/schema';
import { z } from 'zod';
import type { AuditDiff } from './audit.js';
import type { EffectiveSchema, SchemaWarning } from './effective-schema.js';
import { isAllowed, type Policy } from './policy.js';

export type ActionTarget = 'one' | 'many' | 'none';
export const ACTION_TARGETS: readonly ActionTarget[] = ['one', 'many', 'none'];

/** JSON Schema keyword `ref()` puts on an input field: the config-style key of its entity. */
export const REF_KEYWORD = 'x-warden-ref';

/** Most records a `target: 'many'` action runs against. */
export const MAX_ACTION_RECORDS = 500;
export const DEFAULT_MAX_AFFECTED_ROWS = 1000;

/** One input field's JSON Schema, as `z.toJSONSchema` gives it. */
export type InputProperty = Record<string, unknown>;

/** An action's input as JSON Schema: always an object of the supported field types. */
export interface InputSchema {
  type: 'object';
  properties: Record<string, InputProperty>;
  required?: string[];
  [keyword: string]: unknown;
}

/** An input field that picks records of another entity. */
export interface InputRef<E = string> {
  field: string;
  /** Config-style table key, or the entity key once resolved. */
  entity: E;
  /** `z.array(ref(...))`. */
  many: boolean;
}

/** What Warden needs to know about an action, checked and taken from its definition. */
export interface ActionSpec {
  name: string;
  label: string;
  description?: string;
  /** Config-style table key. */
  on: string;
  target: ActionTarget;
  /** Config-style table key → writes `run` may make. */
  permissions: Record<string, WriteAction[]>;
  confirm: 'preview' | 'confirm';
  destructive: boolean;
  requireReason: boolean;
  maxAffectedRows: number;
  timeoutMs?: number;
  inputSchema: InputSchema;
  refs: InputRef[];
  /** Input fields marked `.meta({ sensitive: true })`, redacted in the audit log. */
  sensitive: string[];
}

const DEFINITION_KEYS = new Set([
  'name',
  'label',
  'description',
  'on',
  'target',
  'permissions',
  'input',
  'defaults',
  'confirm',
  'destructive',
  'requireReason',
  'maxAffectedRows',
  'timeoutMs',
  'run',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isZodObject = (value: unknown): value is z.ZodObject =>
  isObject(value) &&
  isObject(value._zod) &&
  isObject(value._zod.def) &&
  value._zod.def.type === 'object';

const positiveInt = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

/** Why an input field (its JSON Schema) can't be rendered as a form control, if it can't. */
function unsupportedField(property: InputProperty): string | undefined {
  let p = property;
  if (Array.isArray(p.type)) {
    const types = p.type as unknown[];
    const nonNull = types.filter((t) => t !== 'null');
    if (types.length !== 2 || nonNull.length !== 1) return 'unions are not supported';
    p = { ...p, type: nonNull[0] };
  }
  if (Array.isArray(p.anyOf)) {
    const options = p.anyOf as InputProperty[];
    const nonNull = options.filter((o) => o.type !== 'null');
    // `.nullable()` is the only union a form can show.
    if (options.length !== 2 || nonNull.length !== 1) return 'unions are not supported';
    p = nonNull[0]!;
  }
  if (p.type === 'array') {
    return isObject(p.items) && scalarField(p.items)
      ? undefined
      : 'arrays must hold strings, numbers, booleans, enums, dates or refs';
  }
  return scalarField(p)
    ? undefined
    : 'only strings, numbers, booleans, enums and dates are supported';
}

const scalarField = (p: InputProperty) =>
  ['string', 'number', 'integer', 'boolean'].includes(p.type as string) && !('anyOf' in p);

/** The nullable-unwrapped schema of a field. */
function unwrap(property: InputProperty): InputProperty {
  if (Array.isArray(property.type)) {
    return { ...property, type: (property.type as unknown[]).find((t) => t !== 'null') };
  }
  if (!Array.isArray(property.anyOf)) return property;
  return (property.anyOf as InputProperty[]).find((o) => o.type !== 'null') ?? property;
}

function inputSchemaOf(input: z.ZodObject, problem: (message: string) => void) {
  let schema: Record<string, unknown>;
  try {
    // Transforms convert in input mode but can't be described as what `run` receives.
    z.toJSONSchema(input, { io: 'output' });
    schema = z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>;
  } catch (err) {
    problem(`input can't be shown as a form: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  delete schema.$schema;
  const properties = (isObject(schema.properties) ? schema.properties : {}) as Record<
    string,
    InputProperty
  >;
  const refs: InputRef[] = [];
  const sensitive: string[] = [];
  for (const [field, property] of Object.entries(properties)) {
    const message = unsupportedField(property);
    if (message) problem(`input field "${field}": ${message}`);
    const p = unwrap(property);
    const items = p.type === 'array' && isObject(p.items) ? p.items : undefined;
    const ref = (items ?? p)[REF_KEYWORD];
    if (typeof ref === 'string') refs.push({ field, entity: ref, many: items !== undefined });
    if (property.sensitive === true || p.sensitive === true) sensitive.push(field);
  }
  // The server rejects unknown keys rather than stripping them.
  const inputSchema = { ...schema, type: 'object', properties, additionalProperties: false };
  return { inputSchema: inputSchema as InputSchema, refs, sensitive };
}

export type ActionDefinitionCheck =
  { ok: true; specs: ActionSpec[] } | { ok: false; errors: string[] };

/**
 * Check what an actions module returned: a list of `defineAction` definitions with unique,
 * well-formed names, known permissions, and input a form can be built from. Every problem is
 * reported, so a module can be fixed in one go.
 */
export function checkActionDefinitions(definitions: unknown): ActionDefinitionCheck {
  if (!Array.isArray(definitions)) {
    return { ok: false, errors: ['the module must return an array of actions'] };
  }
  const errors: string[] = [];
  const specs: ActionSpec[] = [];
  const names = new Set<string>();
  definitions.forEach((definition: unknown, i) => {
    if (!isObject(definition)) {
      errors.push(`action ${i}: expected an object from defineAction`);
      return;
    }
    const { name } = definition;
    const at = typeof name === 'string' && name ? `action "${name}"` : `action ${i}`;
    const problem = (message: string) => errors.push(`${at}: ${message}`);
    const before = errors.length;

    if (typeof name !== 'string' || !ACTION_NAME.test(name)) {
      problem('name must match ^[a-z][a-z0-9-]*$');
    } else if (names.has(name)) {
      problem('name is used by another action');
    } else {
      names.add(name);
    }
    for (const key of Object.keys(definition)) {
      if (!DEFINITION_KEYS.has(key)) problem(`unknown key "${key}"`);
    }
    const {
      label,
      description,
      on,
      target = 'one',
      permissions,
      input,
      defaults,
      run,
    } = definition;
    const { confirm = 'preview', destructive = false, requireReason = false } = definition;
    const { maxAffectedRows = DEFAULT_MAX_AFFECTED_ROWS, timeoutMs } = definition;
    if (typeof label !== 'string' || !label.trim()) problem('label is required');
    if (description !== undefined && typeof description !== 'string') {
      problem('description must be a string');
    }
    if (typeof on !== 'string' || !on) problem('on must name a table');
    if (!ACTION_TARGETS.includes(target as ActionTarget)) {
      problem('target must be "one", "many" or "none"');
    }
    const permitted: Record<string, WriteAction[]> = {};
    if (!isObject(permissions)) {
      problem('permissions must map tables to create, update and delete');
    } else {
      for (const [table, actions] of Object.entries(permissions)) {
        if (actions === undefined) continue;
        if (
          !Array.isArray(actions) ||
          !actions.every((a) => WRITE_ACTIONS.includes(a as WriteAction))
        ) {
          problem(`permissions.${table} may only list create, update and delete`);
          continue;
        }
        permitted[table] = [...new Set(actions as WriteAction[])];
      }
    }
    if (confirm !== 'preview' && confirm !== 'confirm') {
      problem('confirm must be "preview" or "confirm"');
    }
    if (typeof destructive !== 'boolean') problem('destructive must be a boolean');
    if (typeof requireReason !== 'boolean') problem('requireReason must be a boolean');
    if (!positiveInt(maxAffectedRows)) problem('maxAffectedRows must be a positive integer');
    if (timeoutMs !== undefined && !positiveInt(timeoutMs)) {
      problem('timeoutMs must be a positive integer');
    }
    if (typeof run !== 'function') problem('run must be a function');
    if (defaults !== undefined && typeof defaults !== 'function') {
      problem('defaults must be a function');
    }
    let converted: ReturnType<typeof inputSchemaOf>;
    if (input === undefined) {
      converted = {
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        refs: [],
        sensitive: [],
      };
    } else if (!isZodObject(input)) {
      problem('input must be a z.object() from the zod Warden passes in');
    } else {
      converted = inputSchemaOf(input, problem);
    }
    if (errors.length > before || !converted) return;

    specs.push({
      name: name as string,
      label: label as string,
      ...(typeof description === 'string' ? { description } : {}),
      on: on as string,
      target: target as ActionTarget,
      permissions: permitted,
      confirm: confirm as ActionSpec['confirm'],
      destructive: destructive as boolean,
      requireReason: requireReason as boolean,
      maxAffectedRows: maxAffectedRows as number,
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
      ...converted,
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, specs };
}

/** An enabled action with its tables resolved to entity keys and config applied. */
export interface ResolvedAction extends Omit<ActionSpec, 'on' | 'permissions' | 'refs'> {
  /** Entity key. */
  on: string;
  /** Entity key → writes `run` may make. */
  permissions: Record<string, WriteAction[]>;
  refs: InputRef[];
}

export interface ActionPolicy {
  /** Enabled actions only: disabled ones don't exist as far as requests are concerned. */
  actions: Map<string, ResolvedAction>;
  /** Role → action names it may run (`*` for all). */
  grants: Map<string, Set<string>>;
}

export interface ResolvedActionPolicy {
  actionPolicy: ActionPolicy;
  warnings: SchemaWarning[];
  /** Definitions that can never work against this schema; startup should fail. */
  errors: string[];
}

/**
 * Match actions to the schema and config. An action that names a table which isn't exposed, or
 * may write something a table `deny` forbids, is disabled with a warning, like any other
 * config/DB mismatch; so is one config disables. Config naming an action that doesn't exist is a
 * warning too.
 */
export function resolveActionPolicy(
  specs: readonly ActionSpec[],
  schema: EffectiveSchema,
  policy: Policy,
  config: WardenConfig,
): ResolvedActionPolicy {
  const warnings: SchemaWarning[] = [];
  const errors: string[] = [];
  const defaultSchema = config.schemas[0] ?? 'public';
  const byTable = new Map(schema.entities.map((e) => [`${e.schema}.${e.name}`, e]));
  const entityOf = (tableKey: string) =>
    byTable.get(tableKey.includes('.') ? tableKey : `${defaultSchema}.${tableKey}`);

  const actions = new Map<string, ResolvedAction>();
  for (const spec of specs) {
    const path = `actions.${spec.name}`;
    const disable = (message: string) =>
      warnings.push({ path, message: `${message}; the action is disabled` });
    const settings = config.actions[spec.name];
    if (settings?.disabled) continue;

    const missing = [
      spec.on,
      ...Object.keys(spec.permissions),
      ...spec.refs.map((r) => r.entity),
    ].filter((table) => !entityOf(table));
    if (missing.length > 0) {
      disable(
        `${[...new Set(missing)].map((t) => `table "${t}"`).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not exposed`,
      );
      continue;
    }
    const on = entityOf(spec.on)!;
    const permissions: Record<string, WriteAction[]> = {};
    for (const [table, writes] of Object.entries(spec.permissions)) {
      const key = entityOf(table)!.key;
      permissions[key] = [...new Set([...(permissions[key] ?? []), ...writes])];
    }
    const denied = Object.entries(permissions).flatMap(([key, writes]) =>
      writes.filter((w) => policy.denied.get(key)?.has(w)).map((w) => `${w} on "${key}"`),
    );
    if (denied.length > 0) {
      disable(`its permissions include ${denied.join(', ')}, which config denies`);
      continue;
    }
    if (spec.target !== 'none' && on.primaryKey.length === 0) {
      errors.push(
        `action "${spec.name}": target "${spec.target}" needs records, but "${on.key}" has no primary key`,
      );
      continue;
    }
    actions.set(spec.name, {
      ...spec,
      label: settings?.label ?? spec.label,
      requireReason: spec.requireReason || settings?.requireReason === true,
      on: on.key,
      permissions,
      refs: spec.refs.map((r) => ({ ...r, entity: entityOf(r.entity)!.key })),
    });
  }

  const defined = new Set(specs.map((s) => s.name));
  const grants = new Map<string, Set<string>>();
  for (const [role, { actions: names }] of Object.entries(config.roles)) {
    names.forEach((name, i) => {
      if (name !== '*' && !defined.has(name)) {
        warnings.push({
          path: `roles.${role}.actions.${i}`,
          message: `action "${name}" is not defined`,
        });
      }
    });
    grants.set(role, new Set(names));
  }
  for (const name of Object.keys(config.actions)) {
    if (!defined.has(name)) {
      warnings.push({ path: `actions.${name}`, message: `action "${name}" is not defined` });
    }
  }
  return { actionPolicy: { actions, grants }, warnings, errors };
}

/**
 * The action, if someone holding `roles` may run it: it is enabled, one of their roles grants it,
 * no table `deny` covers what it writes, and they may read its entity and every entity its input
 * picks from. They don't need the table grants for what it writes: granting an action is a
 * deliberate, narrow escalation. To everyone else it doesn't exist.
 */
export function canRunAction(
  actionPolicy: ActionPolicy,
  policy: Policy,
  roles: readonly string[],
  name: string,
): ResolvedAction | undefined {
  const action = actionPolicy.actions.get(name);
  if (!action) return undefined;
  const granted = roles.some((role) => {
    const names = actionPolicy.grants.get(role);
    return names !== undefined && (names.has('*') || names.has(name));
  });
  if (!granted) return undefined;
  const denied = Object.entries(action.permissions).some(([key, writes]) =>
    writes.some((w) => policy.denied.get(key)?.has(w)),
  );
  if (denied) return undefined;
  const readable = [action.on, ...action.refs.map((r) => r.entity)];
  if (!readable.every((key) => isAllowed(policy, roles, key, 'read'))) return undefined;
  return action;
}

/** Every action someone holding `roles` may run, by name. */
export function runnableActions(
  actionPolicy: ActionPolicy,
  policy: Policy,
  roles: readonly string[],
): ResolvedAction[] {
  return [...actionPolicy.actions.keys()]
    .map((name) => canRunAction(actionPolicy, policy, roles, name))
    .filter((a): a is ResolvedAction => a !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const REDACTED = '[redacted]';

/** Input as the audit log stores it: sensitive fields replaced. */
export function redactInput(
  input: Record<string, unknown>,
  sensitive: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, sensitive.includes(k) ? REDACTED : v]),
  );
}

/** One row an action changed, as preview shows it and the audit log records it. */
export interface ActionChange {
  operation: WriteAction;
  entity: string;
  recordId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: AuditDiff;
  /**
   * For creates, the fields `run` set, as written; the rest of the row comes from defaults and
   * sequences, which differ between a preview and the run.
   */
  values?: Record<string, unknown>;
}

/** JSON with object keys sorted, so equal values always serialize the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

/**
 * What a preview token signs: the request and the change set it produced. Creates are compared
 * by the values `run` gave, since a rolled-back preview still consumes sequence values.
 */
export function previewTokenPayload(run: {
  name: string;
  input: unknown;
  records: readonly string[];
  changes: readonly ActionChange[];
}): string {
  return canonicalJson({
    name: run.name,
    input: run.input,
    records: run.records,
    changes: run.changes.map((c) =>
      c.operation === 'create'
        ? { operation: c.operation, entity: c.entity, values: c.values ?? null }
        : { operation: c.operation, entity: c.entity, recordId: c.recordId, diff: c.diff },
    ),
  });
}
