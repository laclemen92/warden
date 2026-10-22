import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type WardenConfig } from '@wardenhq/config';

export const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../../examples/basic/warden.config.yaml', import.meta.url),
);

/** The example config with `edit` applied, written to a temporary file; returns its path. */
export function exampleConfigWith(edit: (config: WardenConfig) => void): string {
  const config = parseConfig(readFileSync(EXAMPLE_CONFIG, 'utf8'), EXAMPLE_CONFIG);
  edit(config);
  const path = join(mkdtempSync(join(tmpdir(), 'warden-config-')), 'warden.config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

/** The example config, with admins also allowed to hard-delete companies. */
export const exampleConfigDeletingCompanies = (defaults: Partial<WardenConfig['defaults']> = {}) =>
  exampleConfigWith((config) => {
    config.tables.companies = { ...config.tables.companies!, allowDelete: true };
    config.roles.admin!.grants.companies = ['delete'];
    Object.assign(config.defaults, defaults);
  });
