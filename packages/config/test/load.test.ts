import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, requireAccess } from '../src/index.js';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'warden-config-'));
});

describe('loadConfig', () => {
  it('uses defaults when no config file exists', async () => {
    const { config, path } = await loadConfig({ cwd, env: {} });
    expect(path).toBeNull();
    expect(config.defaults.expose).toBe('all');
  });

  it('finds config files in the working directory, preferring YAML', async () => {
    writeFileSync(join(cwd, 'warden.config.json'), '{"defaults":{"expose":"none"}}');
    expect((await loadConfig({ cwd, env: {} })).path).toBe(join(cwd, 'warden.config.json'));

    writeFileSync(join(cwd, 'warden.config.yaml'), 'defaults: { expose: all }');
    const loaded = await loadConfig({ cwd, env: {} });
    expect(loaded.path).toBe(join(cwd, 'warden.config.yaml'));
    expect(loaded.config.defaults.expose).toBe('all');
  });

  it('honors WARDEN_CONFIG relative to cwd, and an explicit path over it', async () => {
    writeFileSync(join(cwd, 'a.yaml'), 'defaults: { expose: none }');
    writeFileSync(join(cwd, 'b.yaml'), 'defaults: { newColumns: hidden }');

    const fromEnv = await loadConfig({ cwd, env: { WARDEN_CONFIG: 'a.yaml' } });
    expect(fromEnv.config.defaults.expose).toBe('none');

    const explicit = await loadConfig({ cwd, path: 'b.yaml', env: { WARDEN_CONFIG: 'a.yaml' } });
    expect(explicit.config.defaults.newColumns).toBe('hidden');
  });

  it('fails when an explicitly named file is missing', async () => {
    const err = await loadConfig({ cwd, env: { WARDEN_CONFIG: 'missing.yaml' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain(join(cwd, 'missing.yaml'));
    expect(err.message).toContain('File not found');
  });

  it('accepts the example config', async () => {
    const example = fileURLToPath(
      new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
    );
    const { config } = await loadConfig({ path: example, env: {} });
    expect(config.tables.users?.columns.password_hash?.hidden).toBe(true);
  });
});

describe('requireAccess', () => {
  it('fails without access, naming the file and the opt-in', async () => {
    writeFileSync(join(cwd, 'warden.config.yaml'), 'roles: { viewer: {} }\n');
    const loaded = await loadConfig({ cwd, env: {} });
    const err = (() => {
      try {
        requireAccess(loaded);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(join(cwd, 'warden.config.yaml'));
    expect((err as ConfigError).message).toMatch(/access: Required\..*access\.allowAll: true/);
  });

  it('fails when running on defaults', async () => {
    const loaded = await loadConfig({ cwd, env: {} });
    expect(() => requireAccess(loaded)).toThrow(/no config file found[\s\S]*access: Required/);
  });

  it('accepts access rules or the allowAll opt-in', async () => {
    for (const source of [
      'access: { allowAll: true }',
      'roles: { viewer: {} }\naccess: { groups: { staff: [viewer] } }',
      'access: {}',
    ]) {
      writeFileSync(join(cwd, 'warden.config.yaml'), source);
      const loaded = await loadConfig({ cwd, env: {} });
      expect(() => requireAccess(loaded)).not.toThrow();
    }
  });
});
