// Writes warden.config.schema.json from the built zod schema, or with --check fails if it's stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { configJsonSchema } from '../dist/json-schema.js';

const file = new URL('../warden.config.schema.json', import.meta.url);
const json = `${JSON.stringify(configJsonSchema(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const committed = readFileSync(file, 'utf8');
  if (committed !== json) {
    console.error(
      'packages/config/warden.config.schema.json is out of date. ' +
        'Run `pnpm --filter @wardenhq/config schema:json` and commit the result.',
    );
    process.exit(1);
  }
  console.log('warden.config.schema.json is up to date.');
} else {
  writeFileSync(file, json);
  console.log('Wrote packages/config/warden.config.schema.json');
}
