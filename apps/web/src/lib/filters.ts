import {
  OPERATORS_BY_CATEGORY,
  checkFieldValue,
  fieldCategory,
  type Condition,
  type Entity,
  type Field,
  type FieldCategory,
  type Filter,
  type Operator,
  type Scalar,
} from '@wardenhq/core';

/**
 * One row in the filter builder. `values` holds AST-ready strings: none for null checks, two for
 * `between` (either may be empty for an open-ended range), any number for `in`/`notIn`, else one.
 */
export interface DraftCondition {
  id: string;
  field: string;
  op: Operator;
  values: string[];
}

export type ValueArity = 'none' | 'one' | 'range' | 'list';

export function valueArity(op: Operator): ValueArity {
  switch (op) {
    case 'isNull':
    case 'isNotNull':
      return 'none';
    case 'between':
      return 'range';
    case 'in':
    case 'notIn':
      return 'list';
    default:
      return 'one';
  }
}

export const operatorsFor = (field: Field): readonly Operator[] =>
  OPERATORS_BY_CATEGORY[fieldCategory(field)];

const DEFAULT_OPERATOR: Record<FieldCategory, Operator> = {
  text: 'contains',
  number: 'eq',
  temporal: 'between',
  boolean: 'eq',
  uuid: 'eq',
  enum: 'eq',
  json: 'isNotNull',
  other: 'isNotNull',
};

export const defaultOperator = (field: Field): Operator => DEFAULT_OPERATOR[fieldCategory(field)];

const OPERATOR_LABELS: Record<Operator, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  notIn: 'is none of',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  between: 'between',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  isNull: 'is empty',
  isNotNull: 'is not empty',
};

const TEMPORAL_LABELS: Partial<Record<Operator, string>> = {
  gt: 'after',
  gte: 'on or after',
  lt: 'before',
  lte: 'on or before',
};

export function operatorLabel(field: Field, op: Operator): string {
  return (fieldCategory(field) === 'temporal' && TEMPORAL_LABELS[op]) || OPERATOR_LABELS[op];
}

let nextId = 0;
export const draftId = () => `c${++nextId}`;

export function newDraft(field: Field): DraftCondition {
  return { id: draftId(), field: field.name, op: defaultOperator(field), values: [] };
}

/** Change operator, keeping the value when the new operator takes the same shape. */
export function withOperator(draft: DraftCondition, op: Operator): DraftCondition {
  const same = valueArity(op) === valueArity(draft.op);
  return { ...draft, op, values: same ? draft.values : [] };
}

export type DraftResult =
  | { status: 'empty' }
  | { status: 'invalid'; message: string }
  | { status: 'ok'; condition: Condition };

function toScalar(field: Field, value: string): Scalar {
  if (fieldCategory(field) === 'boolean') return value === 'true';
  // Numbers stay strings so int8/numeric keep their precision; the server accepts both.
  return value;
}

/** Turn a draft into a condition. Drafts still missing a value are `empty`, not errors. */
export function draftToCondition(entity: Entity, draft: DraftCondition): DraftResult {
  const field = entity.fields.find((f) => f.name === draft.field);
  if (!field) return { status: 'invalid', message: 'Unknown field' };
  const values = draft.values.map((v) => v.trim());
  const check = (list: string[]): string | undefined => {
    for (const v of list) {
      const message = checkFieldValue(field, toScalar(field, v));
      if (message) return `${field.label}: ${message}`;
    }
    return undefined;
  };
  const name = field.name;

  switch (draft.op) {
    case 'isNull':
    case 'isNotNull':
      return { status: 'ok', condition: { field: name, op: draft.op } };
    case 'between': {
      const [from = '', to = ''] = values;
      if (!from && !to) return { status: 'empty' };
      const message = check([from, to].filter(Boolean));
      if (message) return { status: 'invalid', message };
      // An open-ended range is just a bound.
      if (!to) return { status: 'ok', condition: { field: name, op: 'gte', value: from } };
      if (!from) return { status: 'ok', condition: { field: name, op: 'lte', value: to } };
      return {
        status: 'ok',
        condition: {
          field: name,
          op: 'between',
          value: [toScalar(field, from), toScalar(field, to)],
        },
      };
    }
    case 'in':
    case 'notIn': {
      const list = [...new Set(values.filter(Boolean))];
      if (list.length === 0) return { status: 'empty' };
      const message = check(list);
      if (message) return { status: 'invalid', message };
      return {
        status: 'ok',
        condition: { field: name, op: draft.op, value: list.map((v) => toScalar(field, v)) },
      };
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      // Search terms keep their spaces.
      const value = draft.values[0] ?? '';
      if (!value) return { status: 'empty' };
      return { status: 'ok', condition: { field: name, op: draft.op, value } };
    }
    default: {
      const value = values[0] ?? '';
      if (!value) return { status: 'empty' };
      const message = check([value]);
      if (message) return { status: 'invalid', message };
      return {
        status: 'ok',
        condition: { field: name, op: draft.op, value: toScalar(field, value) },
      };
    }
  }
}

export function conditionToDraft(condition: Condition): DraftCondition {
  const values =
    'value' in condition
      ? (Array.isArray(condition.value) ? condition.value : [condition.value]).map(String)
      : [];
  return { id: draftId(), field: condition.field, op: condition.op, values };
}

/** Combine conditions the way the builder does: all must match. */
export function conditionsToFilter(conditions: Condition[]): Filter | undefined {
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : { and: conditions };
}

const isCondition = (node: unknown): node is Condition =>
  typeof node === 'object' &&
  node !== null &&
  typeof (node as { field?: unknown }).field === 'string' &&
  typeof (node as { op?: unknown }).op === 'string';

/**
 * The flat list of conditions the builder can edit, or `undefined` for a filter it can't
 * represent (`or`, `not`, nesting, or malformed JSON), which is then shown as a custom filter.
 */
export function filterToConditions(raw: string | undefined): Condition[] | undefined {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (isCondition(parsed)) return [parsed];
  if (typeof parsed === 'object' && parsed !== null && 'and' in parsed) {
    const children = (parsed as { and: unknown }).and;
    if (Array.isArray(children) && children.every(isCondition)) return children;
  }
  return undefined;
}

/** Human-readable summary of a condition, e.g. `Status is any of paid, shipped`. */
export function describeCondition(entity: Entity, condition: Condition): string {
  const field = entity.fields.find((f) => f.name === condition.field);
  const label = field?.label ?? condition.field;
  const op = field ? operatorLabel(field, condition.op) : OPERATOR_LABELS[condition.op];
  if (!('value' in condition)) return `${label} ${op}`;
  if (condition.op === 'between') {
    return `${label} between ${String(condition.value[0])} and ${String(condition.value[1])}`;
  }
  const value = Array.isArray(condition.value)
    ? condition.value.map(String).join(', ')
    : String(condition.value);
  return `${label} ${op} ${value}`;
}

// Temporal inputs. Browsers' date/time pickers have no time zone, so `timestamptz` values carry
// the browser's offset; otherwise the database would read them in its own session time zone.

export type TemporalInput = 'date' | 'time' | 'datetime-local';

export function temporalInputType(field: Field): TemporalInput {
  if (field.dataType === 'date') return 'date';
  if (field.dataType === 'time' || field.dataType === 'timetz') return 'time';
  return 'datetime-local';
}

const pad = (n: number) => String(n).padStart(2, '0');

function offsetSuffix(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Filter value → what the `<input>` shows. */
export function toInputValue(field: Field, value: string): string {
  if (field.dataType !== 'timestamptz' || !value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace(' ', 'T');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** What the `<input>` produced → filter value. */
export function fromInputValue(field: Field, value: string): string {
  if (field.dataType !== 'timestamptz' || !value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return `${withSeconds}${offsetSuffix(date)}`;
}
