import type { Entity } from './effective-schema.js';
import { checkFieldValue, fieldCategory, type Filter, type Scalar } from './filter.js';
import { fromBase64Url, toBase64Url } from './encoding.js';
import { fieldSchema } from './validation.js';

/**
 * Opaque, URL-safe id for a row. Single-column keys use the value itself (`/users/42`);
 * composite keys use base64url-encoded JSON. Clients should treat ids as opaque.
 * Returns null when the entity has no primary key or a key value is null.
 */
export function encodeRecordId(entity: Entity, row: Record<string, unknown>): string | null {
  if (entity.primaryKey.length === 0) return null;
  const values = entity.primaryKey.map((key) => row[key]);
  if (values.some((v) => v === null || v === undefined)) return null;
  return values.length === 1 ? String(values[0]) : toBase64Url(JSON.stringify(values));
}

export type RecordIdDecoding = { ok: true; filter: Filter } | { ok: false; message: string };

/** Decode a record id into an equality filter on the primary key, validating each value. */
export function decodeRecordId(entity: Entity, id: string): RecordIdDecoding {
  const keys = entity.primaryKey;
  if (keys.length === 0) return { ok: false, message: `${entity.label} rows cannot be addressed` };

  let values: unknown[];
  if (keys.length === 1) {
    values = [id];
  } else {
    const json = fromBase64Url(id);
    try {
      values = json === undefined ? [] : JSON.parse(json);
    } catch {
      values = [];
    }
    if (!Array.isArray(values) || values.length !== keys.length) {
      return { ok: false, message: 'malformed record id' };
    }
  }

  const conditions: Filter[] = [];
  for (const [i, key] of keys.entries()) {
    const f = entity.fields.find((x) => x.name === key);
    let value = values[i];
    // Path segments are always strings; booleans arrive as "true"/"false".
    if (f && fieldCategory(f) === 'boolean' && (value === 'true' || value === 'false')) {
      value = value === 'true';
    }
    const scalar =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    // Ids are checked like write values too (integers in range, real dates, no NUL), so a value
    // the column can't hold is a 404 here rather than a Postgres error.
    if (
      !f ||
      !scalar ||
      checkFieldValue(f, value as Scalar) ||
      !fieldSchema({ ...f, nullable: false }).safeParse(value).success
    ) {
      return { ok: false, message: 'malformed record id' };
    }
    conditions.push({ field: key, op: 'eq', value: value as Scalar });
  }
  return { ok: true, filter: conditions.length === 1 ? conditions[0]! : { and: conditions } };
}
