import type { MockOidc } from '@wardenhq/mock-oidc';
import { createDatabase, migrate, MIGRATIONS } from '@wardenhq/pg-adapter';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden, parseMigrateFlag } from '../src/warden.js';
import { ALLOW_ALL_CONFIG, authEnv, startTestIdp, writeConfig } from './helpers/auth.js';

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;

const start = (env: Record<string, string> = {}) =>
  createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: writeConfig(ALLOW_ALL_CONFIG),
      ...authEnv(idp),
      ...env,
    },
  });

const wardenSchemaExists = async () => {
  const { rows } = await sqlPool.query(
    `select 1 from information_schema.schemata where schema_name = 'warden'`,
  );
  return rows.length > 0;
};

beforeAll(async () => {
  db = await startPostgres({ sql: [await readExampleSql('basic/schema.sql')] });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
}, 120_000);

afterAll(async () => {
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

describe('WARDEN_MIGRATE', () => {
  it('parses boolean-ish values', () => {
    expect(parseMigrateFlag(undefined)).toBe(true);
    expect(parseMigrateFlag('')).toBe(true);
    for (const on of ['true', 'TRUE', '1', 'yes', 'on']) expect(parseMigrateFlag(on)).toBe(true);
    for (const off of ['false', 'False', '0', 'no', 'off', ' false ']) {
      expect(parseMigrateFlag(off)).toBe(false);
    }
    expect(() => parseMigrateFlag('sometimes')).toThrow('WARDEN_MIGRATE must be true or false');
  });

  it('refuses to start without migrating when the schema is behind', async () => {
    await expect(start({ WARDEN_MIGRATE: 'false' })).rejects.toThrow(
      `missing migrations: ${MIGRATIONS.map((m) => m.version).join(', ')}`,
    );
    expect(await wardenSchemaExists()).toBe(false);
  });

  it('rejects an invalid value before touching the database', async () => {
    await expect(start({ WARDEN_MIGRATE: 'maybe' })).rejects.toThrow(/WARDEN_MIGRATE/);
    expect(await wardenSchemaExists()).toBe(false);
  });

  it('starts without migrating once the schema is current', async () => {
    const handle = createDatabase({ connectionString: db.connectionString });
    try {
      await migrate(handle.db);
    } finally {
      await handle.close();
    }
    const app = await start({ WARDEN_MIGRATE: 'false' });
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('migrates on startup by default', async () => {
    await sqlPool.query('drop schema warden cascade');
    const app = await start();
    try {
      const { rows } = await sqlPool.query('select version from warden.schema_migrations');
      expect(rows.map((r: { version: string }) => r.version).sort()).toEqual(
        MIGRATIONS.map((m) => m.version),
      );
    } finally {
      await app.close();
    }
  });
});
