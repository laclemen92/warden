import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { EffectiveSchema } from '@wardenhq/core';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden, type WardenOptions } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';
import type { MockOidc } from '@wardenhq/mock-oidc';

const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
);

let db: TestDatabase;
let idp: MockOidc;

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  idp = await startTestIdp();
}, 120_000);

afterAll(async () => {
  await idp?.close();
  await db?.stop();
});

async function getSchema(env: Record<string, string>, logger: WardenOptions['logger'] = false) {
  const app = await createWarden({
    env: { DATABASE_URL: db.connectionString, ...authEnv(idp), ...env },
    logger,
  });
  try {
    const cookie = await login(app, 'viewer');
    const res = await app.inject({ method: 'GET', url: '/api/schema', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return { body: res.body, schema: res.json<EffectiveSchema>() };
  } finally {
    await app.close();
  }
}

describe('GET /api/schema', () => {
  it('serves the example database narrowed by the example config', async () => {
    const { body, schema } = await getSchema({ WARDEN_CONFIG: EXAMPLE_CONFIG });

    expect(schema.entities.map((e) => e.key)).toEqual(['companies', 'orders', 'users']);
    const users = schema.entities.find((e) => e.key === 'users');
    expect(users).toMatchObject({
      label: 'Users',
      displayField: 'email',
      defaultSort: { column: 'created_at', direction: 'desc' },
    });
    expect(users?.fields.find((f) => f.name === 'role')?.enumValues).toEqual([
      'member',
      'admin',
      'owner',
    ]);
    expect(body).not.toContain('password_hash');
  });

  it('exposes everything when there is no config file', async () => {
    const { schema } = await getSchema({});
    const users = schema.entities.find((e) => e.key === 'users');
    expect(users?.fields.map((f) => f.name)).toContain('password_hash');
  });

  it('logs config that does not match the database as warnings and still starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-server-'));
    const configPath = join(dir, 'warden.config.yaml');
    writeFileSync(
      configPath,
      'tables:\n  invoices: {}\n  users:\n    columns:\n      nickname: {}\n',
    );

    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });

    const { schema } = await getSchema({ WARDEN_CONFIG: configPath }, { level: 'warn', stream });

    expect(schema.entities.length).toBe(3);
    expect(lines.map((l) => [l.configPath, l.msg])).toEqual([
      ['tables.invoices', 'config: table "public.invoices" does not exist'],
      ['tables.users.columns.nickname', 'config: column "nickname" does not exist'],
    ]);
  });

  it('requires DATABASE_URL', async () => {
    await expect(createWarden({ env: {} })).rejects.toThrow('DATABASE_URL is required');
  });
});
