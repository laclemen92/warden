import type { AuditField, WardenConfig } from '@wardenhq/config';
import { DEFAULT_AUDIT_COLUMNS } from '@wardenhq/config/schema';
import type { Column, QualifiedName, Table } from './schema-model.js';

export type { AuditField };
/** The column `warden.audit_log` keeps each field in. */
export const WARDEN_AUDIT_COLUMNS: Readonly<Record<AuditField, string>> = DEFAULT_AUDIT_COLUMNS;

/** Where audit entries are written and read, as resolved against the database. */
export type AuditStore =
  | { kind: 'warden' }
  | {
      kind: 'table';
      schema: string;
      name: string;
      /** Field → column, for the fields this table stores. Names are as the database has them. */
      columns: Partial<Record<AuditField, string>>;
      source?: { column: string; value: string };
    }
  /** The configured table doesn't match the database, so nothing can be audited or read back. */
  | { kind: 'unavailable' };

type ColumnKind = 'integer' | 'timestamp' | 'text' | 'text[]' | 'json';

interface FieldSpec {
  kind: ColumnKind;
  /** Warden always writes a value; otherwise the column must accept null. */
  notNull?: true;
}

/** What each field needs from its column. A new field is one line here and one in config. */
const FIELD_SPECS: Record<AuditField, FieldSpec> = {
  id: { kind: 'integer', notNull: true },
  occurredAt: { kind: 'timestamp', notNull: true },
  requestId: { kind: 'text' },
  actorSubject: { kind: 'text', notNull: true },
  actorEmail: { kind: 'text' },
  actorRoles: { kind: 'text[]', notNull: true },
  action: { kind: 'text', notNull: true },
  entity: { kind: 'text', notNull: true },
  recordId: { kind: 'text' },
  primaryKey: { kind: 'json' },
  before: { kind: 'json' },
  after: { kind: 'json' },
  diff: { kind: 'json' },
  details: { kind: 'json' },
  reason: { kind: 'text' },
  written: { kind: 'text[]' },
  parentId: { kind: 'integer' },
};

const TEXT = new Set(['text', 'varchar', 'citext']);
const KIND_TYPES: Record<
  ColumnKind,
  { types: ReadonlySet<string>; isArray: boolean; label: string }
> = {
  integer: { types: new Set(['int2', 'int4', 'int8']), isArray: false, label: 'an integer' },
  timestamp: { types: new Set(['timestamptz', 'timestamp']), isArray: false, label: 'a timestamp' },
  text: { types: TEXT, isArray: false, label: 'text' },
  'text[]': { types: TEXT, isArray: true, label: 'a text array' },
  json: { types: new Set(['json', 'jsonb']), isArray: false, label: 'json or jsonb' },
};

const isKind = (column: Column, kind: ColumnKind) =>
  KIND_TYPES[kind].types.has(column.dataType) && column.isArray === KIND_TYPES[kind].isArray;

const writable = (column: Column) => !column.generated && column.identity !== 'always';

/** The configured audit table, qualified; undefined unless `audit.store` is `table`. */
export function auditTableName(config: WardenConfig): QualifiedName | undefined {
  const { store, table } = config.audit;
  if (store !== 'table' || !table) return undefined;
  const [schema, name] = table.includes('.')
    ? table.split('.')
    : [config.schemas[0] ?? 'public', table];
  return { schema: schema!, name: name! };
}

export interface ResolvedAuditStore {
  store: AuditStore;
  /** Why the configured table can't be used. Any problem makes the store `unavailable`. */
  problems: string[];
}

/**
 * Check the configured audit table, as introspected (undefined when it doesn't exist), against
 * the column mapping. A mismatch isn't a startup failure, but nothing may be written that can't be
 * audited, so it makes the store `unavailable` and writes are refused until it is fixed.
 */
export function resolveAuditStore(
  config: WardenConfig,
  table: Table | undefined,
): ResolvedAuditStore {
  const target = auditTableName(config);
  if (!target) return { store: { kind: 'warden' }, problems: [] };
  const { columns: mapped = DEFAULT_AUDIT_COLUMNS, source } = config.audit;
  const label = `${target.schema}.${target.name}`;
  if (!table) {
    return { store: { kind: 'unavailable' }, problems: [`audit table "${label}" does not exist`] };
  }

  const problems: string[] = [];
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const columns: Partial<Record<AuditField, string>> = {};
  for (const [field, name] of Object.entries(mapped) as [AuditField, string | undefined][]) {
    if (name === undefined) continue;
    const column = byName.get(name);
    const where = `column "${name}" (${field})`;
    if (!column) {
      problems.push(`${where} does not exist in "${label}"`);
      continue;
    }
    const spec = FIELD_SPECS[field];
    if (!isKind(column, spec.kind)) {
      problems.push(`${where} is ${column.formattedType}, expected ${KIND_TYPES[spec.kind].label}`);
    } else if (column.maxLength !== undefined) {
      // An overlong value would fail the insert as a data error, blamed on the user's request.
      problems.push(`${where} is ${column.formattedType}, expected no length limit`);
    }
    if (field === 'id') {
      // Warden never writes the id; the database generates it, in increasing order.
      if ((!column.identity && !column.sequenceDefault) || column.generated) {
        problems.push(`${where} needs an identity or sequence default`);
      }
    } else {
      if (!writable(column)) problems.push(`${where} is generated and can't be written`);
      if (!spec.notNull && !column.nullable) {
        problems.push(`${where} is not null, but Warden leaves it empty for some entries`);
      }
    }
    columns[field] = name;
  }
  if (source) {
    const column = byName.get(source.column);
    const where = `source column "${source.column}"`;
    if (!column) problems.push(`${where} does not exist in "${label}"`);
    else if (!isKind(column, 'text') || column.maxLength !== undefined) {
      problems.push(`${where} is ${column.formattedType}, expected text without a length limit`);
    } else if (!writable(column)) problems.push(`${where} is generated and can't be written`);
  }
  // Every insert would fail on a column Warden doesn't fill and the database can't.
  const filled = new Set([...Object.values(columns), ...(source ? [source.column] : [])]);
  for (const column of table.columns) {
    if (!filled.has(column.name) && !column.nullable && !column.hasDefault) {
      problems.push(`column "${column.name}" is not null without a default, and isn't mapped`);
    }
  }

  if (problems.length > 0) {
    return {
      store: { kind: 'unavailable' },
      problems: problems.map((p) => `audit table "${label}": ${p}`),
    };
  }
  return {
    store: {
      kind: 'table',
      schema: table.schema,
      name: table.name,
      columns,
      ...(source ? { source } : {}),
    },
    problems: [],
  };
}
