import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { validateRecord, type EffectiveSchema } from '@wardenhq/core';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '@wardenhq/config';
import { createWarden, type WardenOptions } from '../src/warden.js';
import { ALLOW_ALL_CONFIG, authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';
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

  it('carries the column constraints clients need to mirror write validation', async () => {
    const { schema } = await getSchema({ WARDEN_CONFIG: EXAMPLE_CONFIG });
    const orders = schema.entities.find((e) => e.key === 'orders');
    if (!orders) throw new Error('orders not exposed');
    expect(orders.fields.find((f) => f.name === 'total')).toMatchObject({
      precision: 12,
      scale: 2,
    });
    expect(orders.fields.find((f) => f.name === 'currency')).toMatchObject({ maxLength: 3 });

    // The UI builds its validation from the served entity; it must match the server's.
    const input = { company_id: '1', total: '12345678901.00', currency: 'EURO', status: 'lost' };
    expect(validateRecord(orders, input, 'create')).toEqual({
      ok: false,
      errors: [
        { field: 'status', message: expect.stringMatching(/^expected one of/) },
        { field: 'total', message: 'must have at most 10 digits before the decimal point' },
        { field: 'currency', message: 'must be at most 3 characters' },
      ],
    });
  });

  it('exposes everything when config only opts in to allowAll', async () => {
    const { schema } = await getSchema({ WARDEN_CONFIG: writeConfig(ALLOW_ALL_CONFIG) });
    const users = schema.entities.find((e) => e.key === 'users');
    expect(users?.fields.map((f) => f.name)).toContain('password_hash');
  });

  it('logs config that does not match the database as warnings and still starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-server-'));
    const configPath = join(dir, 'warden.config.yaml');
    writeFileSync(
      configPath,
      'tables:\n  invoices: {}\n  users:\n    columns:\n      nickname: {}\n' + ALLOW_ALL_CONFIG,
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
      [
        undefined,
        expect.stringMatching(/^the database role Warden runs as owns warden\.audit_log/),
      ],
      [
        undefined,
        'access.allowAll is on: everyone the identity provider authenticates can sign in and read per defaults.read',
      ],
      ['tables.invoices', 'config: table "public.invoices" does not exist'],
      ['tables.users.columns.nickname', 'config: column "nickname" does not exist'],
    ]);
  });

  it.each([
    ['without a config file', {}],
    [
      'when config has no access section',
      { WARDEN_CONFIG: writeConfig('roles: { viewer: {} }\n') },
    ],
  ])('fails startup %s', async (_, env: Record<string, string>) => {
    const start = createWarden({
      // A cwd without a config file, so the repo's own files can't be picked up.
      cwd: mkdtempSync(join(tmpdir(), 'warden-server-')),
      env: { DATABASE_URL: db.connectionString, ...authEnv(idp), ...env },
    });
    await expect(start).rejects.toBeInstanceOf(ConfigError);
    await expect(start).rejects.toThrow(/access: Required\..*access\.allowAll: true/);
  });

  it('requires DATABASE_URL', async () => {
    await expect(createWarden({ env: {} })).rejects.toThrow('DATABASE_URL is required');
  });
});
