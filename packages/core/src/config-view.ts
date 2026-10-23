import type { ViewConfig, WardenConfig } from '@wardenhq/config';
import type { EffectiveSchema, SchemaWarning } from './effective-schema.js';
import { filterSchema, validateFilter, type Filter } from './filter.js';
import { validateViewState, type ViewState } from './saved-view.js';
import type { SchemaModel } from './schema-model.js';

/** A shared view defined in config (`tables.<table>.views`), checked against the schema. */
export interface ConfigView {
  key: string;
  /** Entity key. */
  entity: string;
  name: string;
  state: ViewState;
  sidebar: boolean;
  default: boolean;
}

/** Config views' ids in links and the API, kept apart from saved views' numeric ids. */
export const CONFIG_VIEW_PREFIX = 'config:';
export const configViewId = (key: string) => `${CONFIG_VIEW_PREFIX}${key}`;

export interface ConfigViewIssue {
  path: (string | number)[];
  message: string;
}

export interface ResolvedConfigViews {
  views: ConfigView[];
  /** Config/database mismatches: the view is left out. */
  warnings: SchemaWarning[];
  /** Invalid views, which fail startup. */
  errors: ConfigViewIssue[];
}

/** A view as config writes it: what `tables.<table>.views` holds, minus the sidebar settings. */
export interface ExportedView {
  key: string;
  name: string;
  filter?: Filter;
  search?: string;
  sort?: { column: string; direction: 'asc' | 'desc' }[];
  columns?: string[];
}

type ViewDefinition = Pick<ViewConfig, 'filter' | 'search' | 'sort' | 'columns'>;

/** The grid state a config view applies. */
export function configViewState(view: ViewDefinition): ViewState {
  return {
    ...(view.filter !== undefined ? { filter: view.filter as Filter } : {}),
    ...(view.search ? { q: view.search } : {}),
    ...(view.sort
      ? {
          sort: view.sort
            .map((t) => (t.direction === 'desc' ? `-${t.column}` : t.column))
            .join(','),
        }
      : {}),
    ...(view.columns ? { columns: view.columns } : {}),
  };
}

/** A view's state as config writes it, for **Export to config**. */
export function toExportedView(key: string, name: string, state: ViewState): ExportedView {
  const sort = state.sort
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({
      column: t.replace(/^[-+]/, ''),
      direction: t.startsWith('-') ? ('desc' as const) : ('asc' as const),
    }));
  return {
    key,
    name,
    ...(state.filter !== undefined ? { filter: state.filter } : {}),
    ...(state.q ? { search: state.q } : {}),
    ...(sort?.length ? { sort } : {}),
    ...(state.columns?.length ? { columns: state.columns } : {}),
  };
}

/** A config view key from a view's name: `Fraud review queue` → `fraud-review-queue`. */
export function viewKeyFor(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 90)
      .replace(/^-+|-+$/g, '') || 'view';
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  return key;
}

/**
 * Check the config's views against the schema. A view naming a column config hides fails
 * startup, like an invalid filter or sort; one naming a column the database doesn't have is left
 * out with a warning, like any other config/database mismatch.
 */
export function resolveConfigViews(
  model: SchemaModel,
  schema: EffectiveSchema,
  config: WardenConfig,
): ResolvedConfigViews {
  const result: ResolvedConfigViews = { views: [], warnings: [], errors: [] };
  const defaultSchema = config.schemas[0] ?? 'public';

  for (const [tableKey, tableConfig] of Object.entries(config.tables)) {
    if (!tableConfig.views?.length) continue;
    const [schemaName, tableName] = tableKey.includes('.')
      ? (tableKey.split('.') as [string, string])
      : [defaultSchema, tableKey];
    const table = model.tables.find((t) => t.schema === schemaName && t.name === tableName);
    const entity = schema.entities.find((e) => e.schema === schemaName && e.name === tableName);
    tableConfig.views.forEach((view, i) => {
      const path = ['tables', tableKey, 'views', i];
      // Missing tables are already warned about; hidden ones fail config validation.
      if (!table || !entity) {
        result.warnings.push({
          path: path.join('.'),
          message: `view "${view.key}" is disabled: its table does not exist`,
        });
        return;
      }

      const refs: { field: string; path: (string | number)[] }[] = [
        ...(view.columns ?? []).map((field, j) => ({ field, path: [...path, 'columns', j] })),
        ...(view.sort ?? []).map((t, j) => ({
          field: t.column,
          path: [...path, 'sort', j, 'column'],
        })),
      ];
      if (view.filter !== undefined) {
        const parsed = filterSchema.safeParse(view.filter);
        if (!parsed.success) {
          // Reports the structural problems with their paths.
          const checked = validateFilter(entity, view.filter);
          const errors = checked.ok ? [] : checked.errors;
          for (const e of errors.length ? errors : [{ path: '', message: 'invalid filter' }]) {
            result.errors.push({
              path: [...path, 'filter', ...splitPath(e.path)],
              message: e.message,
            });
          }
          return;
        }
        refs.push(...filterRefs(parsed.data, [...path, 'filter']));
      }

      const fields = new Set(entity.fields.map((f) => f.name));
      let missing: string | undefined;
      let hidden = false;
      for (const ref of refs) {
        if (fields.has(ref.field)) continue;
        if (
          table.columns.some((c) => c.name === ref.field) ||
          tableConfig.columns[ref.field]?.hidden
        ) {
          hidden = true;
          result.errors.push({
            path: ref.path,
            message: `column "${ref.field}" is hidden and cannot be used in a view`,
          });
        } else missing ??= ref.field;
      }
      if (hidden) return;
      if (missing !== undefined) {
        result.warnings.push({
          path: path.join('.'),
          message: `view "${view.key}" is disabled: column "${missing}" does not exist`,
        });
        return;
      }

      const state = validateViewState(entity, configViewState(view));
      if (!state.ok) {
        for (const e of state.errors) {
          const [first, ...rest] = splitPath(e.path);
          result.errors.push({
            path: [...path, first === 'q' ? 'search' : (first ?? ''), ...rest],
            message: e.message,
          });
        }
        return;
      }
      result.views.push({
        key: view.key,
        entity: entity.key,
        name: view.name,
        state: state.state,
        sidebar: view.sidebar ?? false,
        default: view.default ?? false,
      });
    });
  }
  return result;
}

function filterRefs(
  filter: Filter,
  path: (string | number)[],
): { field: string; path: (string | number)[] }[] {
  if ('and' in filter) return filter.and.flatMap((f, i) => filterRefs(f, [...path, 'and', i]));
  if ('or' in filter) return filter.or.flatMap((f, i) => filterRefs(f, [...path, 'or', i]));
  if ('not' in filter) return filterRefs(filter.not, [...path, 'not']);
  return [{ field: filter.field, path: [...path, 'field'] }];
}

const splitPath = (path: string): (string | number)[] =>
  path ? path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];

// Strings that YAML would read as something else (booleans, nulls, numbers) are quoted.
const PLAIN = /^[A-Za-z_][\w.-]*( [\w.-]+)*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|nan|inf)$/i;

function scalar(value: unknown): string {
  if (typeof value === 'string') {
    if (PLAIN.test(value) && !RESERVED.test(value)) return value;
    // JSON strings are YAML double-quoted strings, but YAML also refuses these unescaped.
    return JSON.stringify(value).replace(
      /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  }
  return value === null || value === undefined ? 'null' : JSON.stringify(value);
}

const isScalar = (v: unknown) => v === null || typeof v !== 'object';
const isFlat = (v: unknown) => isScalar(v) || (Array.isArray(v) && v.every(isScalar));
// View entries are written in block style however short, so each key is on its own line.
const alwaysBlock = new WeakSet<object>();
const isFlowable = (v: unknown) =>
  isFlat(v) ||
  (!Array.isArray(v) && !alwaysBlock.has(v as object) && Object.values(v as object).every(isFlat));

function flow(value: unknown): string {
  if (isScalar(value)) return scalar(value);
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  const entries = Object.entries(value as object).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, v]) => `${scalar(k)}: ${flow(v)}`).join(', ')} }`;
}

function block(value: object, indent: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => {
      if (isFlowable(item)) return [`${indent}- ${flow(item)}`];
      const lines = block(item as object, `${indent}  `);
      lines[0] = `${indent}- ${lines[0]!.slice(indent.length + 2)}`;
      return lines;
    });
  }
  return Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]: [string, unknown]) =>
      isFlowable(v)
        ? [`${indent}${scalar(k)}: ${flow(v)}`]
        : [`${indent}${scalar(k)}:`, ...block(v as object, `${indent}  `)],
    );
}

function ordered(view: ExportedView): ExportedView {
  const entry = {
    key: view.key,
    name: view.name,
    ...(view.filter !== undefined ? { filter: view.filter } : {}),
    ...(view.search !== undefined ? { search: view.search } : {}),
    ...(view.sort !== undefined ? { sort: view.sort } : {}),
    ...(view.columns !== undefined ? { columns: view.columns } : {}),
  };
  alwaysBlock.add(entry);
  return entry;
}

/** One `tables.<table>.views` entry, as YAML to paste under that key. */
export function viewEntryYaml(view: ExportedView): string {
  return `${block([ordered(view)], '').join('\n')}\n`;
}

/** Views of several tables, as a `tables:` section of config. */
export function viewsConfigYaml(tables: { table: string; views: ExportedView[] }[]): string {
  const section = Object.fromEntries(
    tables.map(({ table, views }) => [table, { views: views.map(ordered) }]),
  );
  return `${block({ tables: section }, '').join('\n')}\n`;
}
