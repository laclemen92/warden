import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { parseConfig, wardenConfigSchema } from '../src/index.js';

const DOC_URL = new URL('../../../docs/config.md', import.meta.url);
const doc = readFileSync(DOC_URL, 'utf8');

const yamlBlocks = [...doc.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? '');

// Placeholder used in the docs for each map's keys, e.g. `tables.<table>.label`.
const RECORD_PLACEHOLDERS: Record<string, string> = {
  tables: '<table>',
  columns: '<column>',
  roles: '<role>',
  grants: '<table>',
  groups: '<group>',
  emailDomains: '<domain>',
};

/** Dotted paths of every leaf key in the config schema. */
function leafPaths(schema: z.core.$ZodType, path: string[] = []): string[] {
  const def = schema._zod.def as z.core.$ZodTypeDef & Record<string, unknown>;
  switch (def.type) {
    case 'default':
    case 'prefault':
    case 'optional':
      return leafPaths(def.innerType as z.core.$ZodType, path);
    case 'object':
      return Object.entries(def.shape as Record<string, z.core.$ZodType>).flatMap(([key, value]) =>
        leafPaths(value, [...path, key]),
      );
    case 'record': {
      const parent = path.at(-1) ?? '';
      const placeholder = RECORD_PLACEHOLDERS[parent];
      if (!placeholder) throw new Error(`Add a docs placeholder for the "${parent}" map`);
      return leafPaths(def.valueType as z.core.$ZodType, [...path, placeholder]);
    }
    default:
      return [path.join('.')];
  }
}

describe('docs/config.md', () => {
  it('has YAML examples', () => {
    expect(yamlBlocks.length).toBeGreaterThan(5);
  });

  it.each(yamlBlocks.map((block, i) => [i + 1, block] as const))(
    'YAML example %i is a valid config',
    (_, block) => {
      expect(() => parseConfig(block, 'docs/config.md')).not.toThrow();
    },
  );

  it('documents every config key', () => {
    const paths = leafPaths(wardenConfigSchema);
    expect(paths).toContain('tables.<table>.columns.<column>.hidden');
    const missing = paths.filter((path) => !doc.includes(`\`${path}\``));
    expect(missing, 'Document these keys in docs/config.md').toEqual([]);
  });
});
