import { z } from 'zod';
import { entityFor, type Entity, type Field } from './effective-schema.js';
import { fieldCategory } from './filter.js';
import {
  UUID,
  checkNumber,
  checkTemporal,
  checkText,
  expectedTemporal,
  integerDigits,
  nestsDeeperThan,
} from './values.js';

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

/**
 * Deepest nesting accepted in a JSON value. Validation and serialization recurse, so a deeper
 * document would overflow the stack instead of being rejected.
 */
export const MAX_JSON_DEPTH = 100;

/** zod error option: distinguishes missing and null from a wrong type. */
const expected = (message: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? 'is required' : issue.input === null ? 'cannot be null' : message;

/** The write-only part of number validation: the column's numeric(p, s) precision. */
function checkPrecision(f: Field, value: number | string): string | undefined {
  if (f.dataType !== 'numeric' || f.precision === undefined) return undefined;
  const max = f.precision - (f.scale ?? 0);
  if (integerDigits(typeof value === 'number' ? String(value) : value) <= max) return undefined;
  return max > 0
    ? `must have at most ${max} digit${max === 1 ? '' : 's'} before the decimal point`
    : `must be less than 1 in absolute value`;
}

/** Schema for one non-null value of `f`'s type (or of its element type, for arrays). */
function valueSchema(f: Field): z.ZodType {
  switch (fieldCategory({ ...f, isArray: false })) {
    case 'text': {
      const max = f.maxLength;
      let schema = z.string({ error: expected('expected a string') }).superRefine((s, ctx) => {
        const message = checkText(s);
        if (message) ctx.addIssue({ code: 'custom', message });
      });
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
          const message = checkNumber(f, value) ?? checkPrecision(f, value);
          if (message) ctx.addIssue({ code: 'custom', message });
        });
    case 'boolean':
      return z.boolean({ error: expected('expected a boolean') });
    case 'temporal': {
      return z.string({ error: expected(expectedTemporal(f)) }).superRefine((s, ctx) => {
        const message = checkTemporal(f, s);
        if (message) ctx.addIssue({ code: 'custom', message });
      });
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
 * Schema for a create or update payload. Read-only fields, and create-only fields on update, are
 * rejected; on create, fields that are NOT NULL without a default are required. Unknown
 * (including hidden) fields are rejected.
 */
export function recordSchema(entity: Entity, mode: WriteMode) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of entityFor(entity, mode).fields) {
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
