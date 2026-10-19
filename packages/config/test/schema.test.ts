import { describe, expect, it } from 'vitest';
import { wardenConfigSchema } from '../src/index.js';

describe('wardenConfigSchema', () => {
  it('exposes everything by default', () => {
    expect(wardenConfigSchema.parse({}).defaults.expose).toBe('all');
  });

  it('rejects unknown keys', () => {
    expect(() => wardenConfigSchema.parse({ defaults: { exposee: 'all' } })).toThrow();
  });
});
