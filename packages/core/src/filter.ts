import { z } from 'zod';
import type { Entity, Field } from './effective-schema.js';
import {
  UUID,
  checkNumber,
  checkTemporal,
  checkText,
  expectedTemporal,
  nestsDeeperThan,
} from './values.js';

/**
 * Filter AST sent by clients. Validate with {@link validateFilter} before compiling: validation
 * is what guarantees fields are exposed and values fit their column.
 */
export type Filter = { and: Filter[] } | { or: Filter[] } | { not: Filter } | Condition;

export type Condition =
  | { field: string; op: 'eq' | 'neq'; value: Scalar }
  | { field: string; op: 'in' | 'notIn'; value: Scalar[] }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: Scalar }
  | { field: string; op: 'between'; value: [Scalar, Scalar] }
  | { field: string; op: 'contains' | 'startsWith' | 'endsWith'; value: string }
  | { field: string; op: 'isNull' | 'isNotNull' };

export type Scalar = string | number | boolean;
export type Operator = Condition['op'];

export const FILTER_LIMITS = {
  maxDepth: 8,
  maxConditions: 100,
  maxListLength: 500,
  maxStringLength: 1000,
} as const;

const scalar = z.union([z.string().max(FILTER_LIMITS.maxStringLength), z.number(), z.boolean()]);
const field = z.string().min(1).max(200);

const conditionSchema = z.discriminatedUnion('op', [
  z.strictObject({ field, op: z.enum(['eq', 'neq']), value: scalar }),
  z.strictObject({
    field,
    op: z.enum(['in', 'notIn']),
    value: z.array(scalar).min(1).max(FILTER_LIMITS.maxListLength),
  }),
  z.strictObject({ field, op: z.enum(['gt', 'gte', 'lt', 'lte']), value: scalar }),
  z.strictObject({ field, op: z.literal('between'), value: z.tuple([scalar, scalar]) }),
  z.strictObject({
    field,
    op: z.enum(['contains', 'startsWith', 'endsWith']),
    value: z.string().min(1).max(FILTER_LIMITS.maxStringLength),
  }),
  z.strictObject({ field, op: z.enum(['isNull', 'isNotNull']) }),
]);

export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(filterSchema).min(1) }),
    z.strictObject({ or: z.array(filterSchema).min(1) }),
    z.strictObject({ not: filterSchema }),
    conditionSchema,
  ]),
);

/** How a column's values can be compared. Arrays and unrecognized types only support null checks. */
export type FieldCategory =
  'text' | 'number' | 'boolean' | 'temporal' | 'uuid' | 'enum' | 'json' | 'other';

const CATEGORY_BY_TYPE: Record<string, FieldCategory> = {
  text: 'text',
  varchar: 'text',
  bpchar: 'text',
  citext: 'text',
  name: 'text',
  int2: 'number',
  int4: 'number',
  int8: 'number',
  numeric: 'number',
  float4: 'number',
  float8: 'number',
  money: 'number',
  bool: 'boolean',
  date: 'temporal',
  timestamp: 'temporal',
  timestamptz: 'temporal',
  time: 'temporal',
  timetz: 'temporal',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'json',
};

export function fieldCategory(f: Field): FieldCategory {
  if (f.isArray) return 'other';
  if (f.enumValues) return 'enum';
  return CATEGORY_BY_TYPE[f.dataType] ?? 'other';
}

const NULL_CHECKS: Operator[] = ['isNull', 'isNotNull'];
const EQUALITY: Operator[] = ['eq', 'neq', 'in', 'notIn', ...NULL_CHECKS];
const ORDERED: Operator[] = [...EQUALITY, 'gt', 'gte', 'lt', 'lte', 'between'];

export const OPERATORS_BY_CATEGORY: Record<FieldCategory, readonly Operator[]> = {
  text: [...ORDERED, 'contains', 'startsWith', 'endsWith'],
  number: ORDERED,
  temporal: ORDERED,
  boolean: ['eq', 'neq', ...NULL_CHECKS],
  uuid: EQUALITY,
  enum: EQUALITY,
  json: NULL_CHECKS,
  other: NULL_CHECKS,
};

/**
 * Error message when `value` can't be compared against field `f`, otherwise undefined. Values are
 * checked like write values for the column's type (integers in range, real dates, no NUL), but
 * not its typmods: comparing a varchar(5) to a longer string is fine.
 */
export function checkFieldValue(f: Field, value: Scalar): string | undefined {
  return checkValue(f, fieldCategory(f), value);
}

function checkValue(f: Field, category: FieldCategory, value: Scalar): string | undefined {
  switch (category) {
    case 'text':
      return typeof value === 'string' ? checkText(value) : 'expected a string';
    case 'number':
      return typeof value === 'boolean' ? 'expected a number' : checkNumber(f, value);
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'expected a boolean';
    case 'temporal':
      return typeof value === 'string' ? checkTemporal(f, value) : expectedTemporal(f);
    case 'uuid':
      return typeof value === 'string' && UUID.test(value) ? undefined : 'expected a UUID';
    case 'enum':
      return typeof value === 'string' && f.enumValues?.includes(value)
        ? undefined
        : `expected one of ${f.enumValues?.map((v) => `"${v}"`).join(', ')}`;
    default:
      return 'values cannot be compared for this field';
  }
}

export interface FilterError {
  /** JSON path into the filter, e.g. `and.1.value`. */
  path: string;
  message: string;
}

const TOO_DEEP = `filters can nest at most ${FILTER_LIMITS.maxDepth} levels`;

export type FilterValidation = { ok: true; filter: Filter } | { ok: false; errors: FilterError[] };

/**
 * Check a client-supplied filter against an entity. Only the entity's exposed fields can be
 * referenced (hidden fields are indistinguishable from nonexistent ones), operators must suit
 * the field's type, and values must parse as that type.
 */
export function validateFilter(entity: Entity, input: unknown): FilterValidation {
  // zod parses recursively, so a deep enough filter would overflow the stack. A filter within the
  // depth limit nests at most two JSON levels per level (an object and its `and`/`or` array).
  if (nestsDeeperThan(input, 2 * FILTER_LIMITS.maxDepth)) {
    return { ok: false, errors: [{ path: '', message: TOO_DEEP }] };
  }
  const parsed = filterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }

  const errors: FilterError[] = [];
  const fields = new Map(entity.fields.map((f) => [f.name, f]));
  let conditions = 0;

  const visit = (node: Filter, path: string[], depth: number) => {
    const at = (...rest: (string | number)[]) => [...path, ...rest].join('.');
    if (depth > FILTER_LIMITS.maxDepth) {
      errors.push({ path: at(), message: TOO_DEEP });
      return;
    }
    if ('and' in node || 'or' in node) {
      const key = 'and' in node ? 'and' : 'or';
      const children = 'and' in node ? node.and : node.or;
      children.forEach((child, i) => visit(child, [...path, key, String(i)], depth + 1));
      return;
    }
    if ('not' in node) {
      visit(node.not, [...path, 'not'], depth + 1);
      return;
    }

    conditions++;
    const f = fields.get(node.field);
    if (!f) {
      errors.push({ path: at('field'), message: `unknown field "${node.field}"` });
      return;
    }
    const category = fieldCategory(f);
    if (!OPERATORS_BY_CATEGORY[category].includes(node.op)) {
      errors.push({
        path: at('op'),
        message: `operator "${node.op}" is not supported for ${f.name}`,
      });
      return;
    }
    if (!('value' in node)) return;
    const values: Scalar[] = Array.isArray(node.value) ? node.value : [node.value];
    values.forEach((value, i) => {
      const message = checkValue(f, category, value);
      if (message) {
        errors.push({ path: Array.isArray(node.value) ? at('value', i) : at('value'), message });
      }
    });
  };

  visit(parsed.data, [], 1);
  if (conditions > FILTER_LIMITS.maxConditions) {
    errors.push({
      path: '',
      message: `filters can have at most ${FILTER_LIMITS.maxConditions} conditions`,
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, filter: parsed.data };
}

/** Free-text search across the entity's searchable fields, as an `or` of `contains`. */
export function searchFilter(entity: Entity, query: string): Filter | undefined {
  // Postgres rejects NUL in a pattern, and no text value can contain one anyway.
  const term = query.replaceAll('\0', '').trim().slice(0, FILTER_LIMITS.maxStringLength);
  if (!term) return undefined;
  const fields = entity.searchable.filter((name) => {
    const f = entity.fields.find((x) => x.name === name);
    return f && fieldCategory(f) === 'text';
  });
  if (fields.length === 0) return undefined;
  return { or: fields.map((name) => ({ field: name, op: 'contains', value: term })) };
}
