import type { WardenConfig } from '@wardenhq/config';
import type { SchemaWarning } from './effective-schema.js';
import type { SchemaModel } from './schema-model.js';

/**
 * Where a signed-in user's internal id is looked up: config's `actor`, checked against the
 * introspected schema. The table may be hidden from the effective schema; only these two columns
 * are ever read from it.
 */
export interface ActorMapping {
  schema: string;
  table: string;
  matchColumn: string;
  idColumn: string;
}

export interface ResolvedActor {
  /** Absent without `actor` config, or when it names a table or column that doesn't exist. */
  mapping?: ActorMapping;
  /** Config's `actor.required`: deny sign-in without an id, including when `mapping` is absent. */
  required: boolean;
  warnings: SchemaWarning[];
}

const MATCH_TYPES = new Set(['text', 'varchar', 'bpchar', 'citext']);

/**
 * Resolve config's `actor` against the introspected schema. Like `resolveSchema`, a mismatch is a
 * warning, never a throw: the mapping is left out, so nobody gets an id (and with `required`,
 * nobody can sign in).
 */
export function resolveActor(model: SchemaModel, config: WardenConfig): ResolvedActor {
  const actor = config.actor;
  if (!actor) return { required: false, warnings: [] };
  const warnings: SchemaWarning[] = [];
  const failed = (path: string, message: string): ResolvedActor => {
    warnings.push({ path, message });
    return { required: actor.required, warnings };
  };

  const defaultSchema = config.schemas[0] ?? 'public';
  const [schema, name] = actor.table.includes('.')
    ? (actor.table.split('.') as [string, string])
    : [defaultSchema, actor.table];
  const table = model.tables.find((t) => t.schema === schema && t.name === name);
  if (!table) return failed('actor.table', `table "${schema}.${name}" does not exist`);

  const column = (key: 'matchColumn' | 'idColumn') =>
    table.columns.find((c) => c.name === actor[key]);
  const match = column('matchColumn');
  if (!match) {
    return failed('actor.matchColumn', `column "${actor.matchColumn}" does not exist`);
  }
  if (match.isArray || !MATCH_TYPES.has(match.dataType)) {
    return failed('actor.matchColumn', `column "${actor.matchColumn}" is not a text column`);
  }
  if (!column('idColumn')) {
    return failed('actor.idColumn', `column "${actor.idColumn}" does not exist`);
  }
  return {
    mapping: { schema, table: name, matchColumn: actor.matchColumn, idColumn: actor.idColumn },
    required: actor.required,
    warnings,
  };
}
