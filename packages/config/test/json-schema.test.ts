import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { configJsonSchema, parseConfig } from '../src/index.js';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

const committed = JSON.parse(read('packages/config/warden.config.schema.json')) as JsonSchema;

interface JsonSchema {
  [keyword: string]: unknown;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
}

const ANNOTATIONS = new Set(['$schema', 'title', 'description', 'default']);

/**
 * Whether `value` matches `schema`, for the keywords zod's draft-07 output uses. Any other keyword
 * throws, so a schema change can't make this pass by being ignored.
 */
function matches(schema: JsonSchema | boolean, value: unknown): boolean {
  if (typeof schema === 'boolean') return schema;
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  const obj = value as Record<string, unknown>;
  return Object.entries(schema).every(([keyword, arg]) => {
    const sub = arg as JsonSchema;
    switch (keyword) {
      case 'type':
        return arg === 'integer'
          ? Number.isInteger(value)
          : arg === 'array'
            ? Array.isArray(value)
            : arg === 'object'
              ? isObject
              : typeof value === arg;
      case 'enum':
        return (arg as unknown[]).includes(value);
      case 'const':
        return value === arg;
      case 'pattern':
        return typeof value !== 'string' || new RegExp(arg as string, 'u').test(value);
      case 'minLength':
        return typeof value !== 'string' || value.length >= (arg as number);
      case 'maxLength':
        return typeof value !== 'string' || value.length <= (arg as number);
      case 'minimum':
        return typeof value !== 'number' || value >= (arg as number);
      case 'maximum':
        return typeof value !== 'number' || value <= (arg as number);
      case 'minItems':
        return !Array.isArray(value) || value.length >= (arg as number);
      case 'items':
        return !Array.isArray(value) || value.every((item) => matches(sub, item));
      case 'anyOf':
        return (arg as JsonSchema[]).some((s) => matches(s, value));
      case 'allOf':
        return (arg as JsonSchema[]).every((s) => matches(s, value));
      case 'required':
        return !isObject || (arg as string[]).every((key) => Object.hasOwn(obj, key));
      case 'properties':
        return (
          !isObject ||
          Object.entries(sub).every(
            ([key, s]) => !Object.hasOwn(obj, key) || matches(s as JsonSchema, obj[key]),
          )
        );
      case 'propertyNames':
        return !isObject || Object.keys(obj).every((key) => matches(sub, key));
      case 'additionalProperties':
        return (
          !isObject ||
          Object.entries(obj).every(
            ([key, v]) =>
              Object.hasOwn(schema.properties ?? {}, key) ||
              matches(arg as JsonSchema | boolean, v),
          )
        );
      default:
        if (ANNOTATIONS.has(keyword)) return true;
        throw new Error(`Unsupported JSON Schema keyword "${keyword}"`);
    }
  });
}

const docBlocks = [...read('docs/config.md').matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map(
  (m) => m[1] ?? '',
);

describe('warden.config.schema.json', () => {
  it('is up to date with the zod schema', () => {
    expect(committed, 'Run `pnpm --filter @wardenhq/config schema:json`').toEqual(
      configJsonSchema(),
    );
  });

  it('is draft-07 and strict about keys', () => {
    expect(committed.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(committed.additionalProperties).toBe(false);
    const props = committed.properties!;
    const valueOf = (key: string) => props[key]!.additionalProperties as JsonSchema;
    expect(valueOf('tables').additionalProperties).toBe(false);
    expect(valueOf('roles').additionalProperties).toBe(false);
    expect(valueOf('tables').properties!.columns!.additionalProperties).toMatchObject({
      additionalProperties: false,
    });
    expect(props.defaults!.properties!.expose!.enum).toEqual(['all', 'none']);
    expect(valueOf('tables').properties!.deny!.items).toMatchObject({
      enum: ['read', 'create', 'update', 'delete', 'export'],
    });
  });

  it('describes every top-level key', () => {
    for (const [key, schema] of Object.entries(committed.properties!)) {
      expect(schema.description, key).toEqual(expect.any(String));
    }
  });

  it.each([
    ...['examples/basic/warden.config.yaml', 'examples/deploy/warden.config.yaml'].map(
      (path) => [path, read(path)] as const,
    ),
    ...docBlocks.map((block, i) => [`docs/config.md example ${i + 1}`, block] as const),
  ])('accepts %s', (_, source) => {
    expect(matches(committed, parse(source) ?? {})).toBe(true);
  });

  it('accepts a JSON config naming its schema', () => {
    expect(matches(committed, { $schema: './warden.config.schema.json' })).toBe(true);
  });

  it('checks every keyword it meets', () => {
    expect(() => matches({ uniqueItems: true }, [])).toThrow(/Unsupported/);
  });

  it.each([
    ['a misspelled top-level key', { tabels: {} }],
    ['a misspelled table key', { tables: { users: { hiden: true } } }],
    ['a misspelled column key', { tables: { users: { columns: { email: { readonly: true } } } } }],
    ['a misspelled role key', { roles: { ops: { grant: {} } } }],
    ['a bad defaults enum', { defaults: { expose: 'some' } }],
    ['a bad grant action', { roles: { ops: { grants: { users: ['write'] } } } }],
    ['a bad table key', { tables: { 'a.b.c': {} } }],
    ['a wrong type', { defaults: { reasonMinLength: '10' } }],
    ['a view without a name', { tables: { orders: { views: [{ key: 'paid' }] } } }],
  ])('rejects %s, as the loader does', (_, config) => {
    expect(matches(committed, config)).toBe(false);
    expect(() => parseConfig(JSON.stringify(config), 'test.json')).toThrow();
  });
});
