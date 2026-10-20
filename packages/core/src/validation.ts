import { z } from 'zod';
import type { Entity, Field } from './effective-schema.js';
import { fieldCategory } from './filter.js';

/**
 * Write validation derived from column constraints (nullability, lengths, enums, numeric
 * precision). The schemas are built only from the `EffectiveSchema`, so the server and the UI
 * build identical ones: the server enforces them, the UI mirrors them for early feedback.
 */
export type WriteMode = 'create' | 'update';

export interface FieldError {
  /** Field the error belongs to; absent when it concerns the record as a whole. */
  field?: string;
  message: string;
}

export type RecordValidation =
  { ok: true; values: Record<string, unknown> } | { ok: false; errors: FieldError[] };

const INTEGER_RANGES: Record<string, [bigint, bigint]> = {
  int2: [-(2n ** 15n), 2n ** 15n - 1n],
  int4: [-(2n ** 31n), 2n ** 31n - 1n],
  int8: [-(2n ** 63n), 2n ** 63n - 1n],
};

const INTEGER = /^-?\d+$/;
const NUMERIC = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const TIME = String.raw`\d{2}:\d{2}(:\d{2}(\.\d+)?)?`;
const OFFSET = String.raw`(Z|[+-]\d{2}(:?\d{2})?)`;
// ISO 8601 and Postgres' text output (`2026-01-02 03:04:05.123456+00`), which is how the API
// returns them, so values read from the API can be written back unchanged.
const TEMPORAL: Record<string, { pattern: RegExp; expected: string }> = {
  date: { pattern: new RegExp(`^${DATE}$`), expected: 'expected a date (YYYY-MM-DD)' },
  timestamp: {
    pattern: new RegExp(`^${DATE}([T ]${TIME}${OFFSET}?)?$`),
    expected: 'expected an ISO 8601 date-time',
  },
  time: { pattern: new RegExp(`^${TIME}${OFFSET}?$`), expected: 'expected a time (HH:MM:SS)' },
};
TEMPORAL.timestamptz = TEMPORAL.timestamp!;
TEMPORAL.timetz = TEMPORAL.time!;

/** Whether the date and time parts of a format-checked value exist (no February 30th or 25:00). */
function isRealDateTime(value: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (date) {
    const [year, month, day] = date.slice(1).map(Number) as [number, number, number];
    // setUTCFullYear, unlike Date.UTC, doesn't map years 0-99 to 1900-1999.
    const daysInMonth = new Date(new Date(0).setUTCFullYear(year, month, 0)).getUTCDate();
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) return false;
  }
  const time = /(?:^|[T ])(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/.exec(value);
  if (time) {
    const [hour, minute, second] = [time[1], time[2], time[3] ?? '0'].map(Number) as [
      number,
      number,
      number,
    ];
    // Like Postgres, allow 24:00:00 and a leap second.
    if (minute > 59 || second > 60 || hour > 24 || (hour === 24 && minute + second > 0)) {
      return false;
    }
  }
  return true;
}

/**
 * Deepest nesting accepted in a JSON value. Validation and serialization recurse, so a deeper
 * document would overflow the stack instead of being rejected.
 */
export const MAX_JSON_DEPTH = 100;

/** Whether `value` nests deeper than `max`, checked without recursion. */
function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (typeof v !== 'object' || v === null) continue;
    if (depth >= max) return true;
    for (const child of Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

/** zod error option: distinguishes missing and null from a wrong type. */
const expected = (message: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? 'is required' : issue.input === null ? 'cannot be null' : message;

/** Number of digits before the decimal point, e.g. 3 for `-123.45`, 0 for `0.5e-3`, 4 for `1.5e3`. */
function integerDigits(value: string): number {
  const [mantissa = '', exponent = '0'] = value.replace(/^-/, '').toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  const leadingZeros = digits.length - digits.replace(/^0+/, '').length;
  if (leadingZeros === digits.length) return 0;
  return Math.max(0, whole.length + Number(exponent) - leadingZeros);
}

function checkNumber(f: Field, value: number | string): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  const range = INTEGER_RANGES[f.dataType];
  if (range) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      return Number.isInteger(value)
        ? 'integers this large must be sent as strings'
        : 'expected an integer';
    }
    if (!INTEGER.test(text)) return 'expected an integer';
    const n = BigInt(text);
    return n < range[0] || n > range[1] ? `must be between ${range[0]} and ${range[1]}` : undefined;
  }
  if (typeof value === 'number' ? !Number.isFinite(value) : !NUMERIC.test(value)) {
    return 'expected a number';
  }
  if (f.dataType === 'numeric' && f.precision !== undefined) {
    const scale = f.scale ?? 0;
    const max = f.precision - scale;
    if (integerDigits(text) > max) {
      return max > 0
        ? `must have at most ${max} digit${max === 1 ? '' : 's'} before the decimal point`
        : `must be less than 1 in absolute value`;
    }
  }
  return undefined;
}

/** Schema for one non-null value of `f`'s type (or of its element type, for arrays). */
function valueSchema(f: Field): z.ZodType {
  switch (fieldCategory({ ...f, isArray: false })) {
    case 'text': {
      const max = f.maxLength;
      let schema = z
        .string({ error: expected('expected a string') })
        // Postgres text can't store NUL bytes.
        .refine((s) => !s.includes('\0'), 'cannot contain NUL characters');
      if (max !== undefined) {
        // Postgres counts characters (code points), not UTF-16 units.
        schema = schema.refine(
          (s) => [...s].length <= max,
          `must be at most ${max} character${max === 1 ? '' : 's'}`,
        );
      }
      return schema;
    }
    case 'number':
      return z
        .union([z.number(), z.string()], { error: expected('expected a number') })
        .superRefine((value, ctx) => {
          const message = checkNumber(f, value);
          if (message) ctx.addIssue({ code: 'custom', message });
        });
    case 'boolean':
      return z.boolean({ error: expected('expected a boolean') });
    case 'temporal': {
      const { pattern, expected: message } = TEMPORAL[f.dataType]!;
      return z
        .string({ error: expected(message) })
        .regex(pattern, message)
        .refine(isRealDateTime, 'is not a valid date/time');
    }
    case 'uuid':
      return z.string({ error: expected('expected a UUID') }).regex(UUID, 'expected a UUID');
    case 'enum': {
      const values = f.enumValues ?? [];
      return z.enum(values as [string, ...string[]], {
        error: expected(`expected one of ${values.map((v) => `"${v}"`).join(', ')}`),
      });
    }
    case 'json':
      // SQL NULL is represented by null; a JSON `null` document can't be written.
      return z
        .unknown()
        .refine((v) => !nestsDeeperThan(v, MAX_JSON_DEPTH), {
          message: `must be nested at most ${MAX_JSON_DEPTH} levels deep`,
          abort: true,
        })
        .pipe(z.json({ error: expected('expected a JSON value') }));
    default:
      // Types without a JSON mapping (bytea, inet, interval, ...) are sent in Postgres' text form.
      return z.string({ error: expected('expected a string') });
  }
}

/** Schema for a value of `f`, including null when the column allows it. */
export function fieldSchema(f: Field): z.ZodType {
  const schema = f.isArray
    ? z.array(valueSchema(f).nullable(), { error: expected('expected an array') })
    : valueSchema(f);
  return f.nullable ? schema.nullable() : schema;
}

/**
 * Schema for a create or update payload. Read-only fields are rejected; on create, fields that
 * are NOT NULL without a default are required. Unknown (including hidden) fields are rejected.
 */
export function recordSchema(entity: Entity, mode: WriteMode) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of entity.fields) {
    if (f.readOnly) {
      shape[f.name] = z.never({ error: 'is read-only' }).optional();
      continue;
    }
    const schema = fieldSchema(f);
    shape[f.name] = mode === 'create' && !f.nullable && !f.hasDefault ? schema : schema.optional();
  }
  return z.strictObject(shape);
}

/** Validate a client-supplied create or update payload against an entity. */
export function validateRecord(entity: Entity, input: unknown, mode: WriteMode): RecordValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ message: 'expected an object of field values' }] };
  }
  const parsed = recordSchema(entity, mode).safeParse(input);
  if (parsed.success) return { ok: true, values: parsed.data };
  return { ok: false, errors: toFieldErrors(parsed.error) };
}

/** Flatten zod issues to one error per field (array element errors name the element). */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.flatMap((issue): FieldError[] => {
    // Hidden fields get the same message as nonexistent ones.
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ field: key, message: `unknown field "${key}"` }));
    }
    const [field, ...rest] = issue.path;
    if (field === undefined) return [{ message: issue.message }];
    const at = rest.length > 0 ? `item ${rest.join('.')}: ` : '';
    return [{ field: String(field), message: `${at}${issue.message}` }];
  });
}
