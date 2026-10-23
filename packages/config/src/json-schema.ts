import { z } from 'zod';
import { wardenConfigSchema } from './schema.js';

/**
 * The config file's JSON Schema, for editor completions and validation. Draft-07 because editor
 * language servers and SchemaStore handle it most reliably. Checks done in `refine`/`superRefine`
 * (reserved action names, cross-table rules) can't be expressed in it and only run at startup.
 */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(wardenConfigSchema, { io: 'input', target: 'draft-7' });
}
