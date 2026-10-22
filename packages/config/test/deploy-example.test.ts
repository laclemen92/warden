import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('examples/deploy mock IdP', () => {
  it('publishes the mock IdP and Warden on loopback only', () => {
    // logLevel 'error' hides the warning for compose's custom `!reset` tag.
    const compose = parse(read('examples/deploy/docker-compose.mock-oidc.yml'), {
      logLevel: 'error',
    }) as {
      services: Record<string, { ports?: string[] }>;
    };
    const ports = Object.values(compose.services).flatMap((s) => s.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it('documents a start command that also starts the default database', () => {
    const commands = read('docs/deployment.md')
      .split('\n')
      .filter((line) => /^docker compose .*docker-compose\.mock-oidc\.yml up\b/.test(line));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).toContain('--profile local-db');
  });
});
