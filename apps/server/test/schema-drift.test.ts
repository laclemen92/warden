import { fileURLToPath } from 'node:url';
import type { SchemaDrift } from '@wardenhq/core';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

type App = Awaited<ReturnType<typeof createWarden>>;
interface DriftBody {
  baseline: { id: string; takenAt: string; takenBy: string | null };
  drift: SchemaDrift;
}

const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
);
const DRIFT = '/api/admin/schema-drift';
const ACKNOWLEDGE = '/api/admin/schema-drift/acknowledge';

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: App;
let admin: string;
let viewer: string;

const start = () =>
  createWarden({
    env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: EXAMPLE_CONFIG, ...authEnv(idp) },
  });

/** Restart Warden so it introspects the database again, keeping the sessions. */
async function restart() {
  await app.close();
  app = await start();
}

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  app = await start();
  admin = await login(app, 'admin');
  viewer = await login(app, 'viewer');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const getDrift = async (cookie = admin) => {
  const res = await app.inject({ method: 'GET', url: DRIFT, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<DriftBody>();
};
const acknowledge = (baselineId: unknown, cookie = admin) =>
  app.inject({ method: 'POST', url: ACKNOWLEDGE, headers: { cookie }, payload: { baselineId } });

describe('schema drift', () => {
  it('shows no drift right after the first start records the baseline', async () => {
    const { baseline, drift } = await getDrift();
    expect(baseline).toMatchObject({ takenBy: null });
    expect(drift).toEqual({
      addedTables: [],
      removedTables: [],
      addedColumns: [],
      removedColumns: [],
      warnings: [],
      snippet: '',
    });
  });

  it('tells the UI which users may open it', async () => {
    const me = async (cookie: string) =>
      (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(await me(admin)).toMatchObject({ admin: ['schema', 'audit', 'roles', 'views'] });
    expect(await me(viewer)).toMatchObject({ admin: [] });
  });

  it('is indistinguishable from a missing route for users without admin: [schema]', async () => {
    const editor = await login(app, 'editor');
    const missing = await app.inject({
      method: 'GET',
      url: '/api/admin/nope',
      headers: { cookie: viewer },
    });
    expect(missing.statusCode).toBe(404);
    const normalize = (body: string) => body.replaceAll(/\/api\/admin\/[\w/-]+/g, '<url>');

    for (const cookie of [viewer, editor]) {
      const get = await app.inject({ method: 'GET', url: DRIFT, headers: { cookie } });
      expect(get.statusCode).toBe(404);
      expect(normalize(get.body)).toBe(normalize(missing.body));

      for (const payload of ['{"baselineId":"1"}', '{not json', '{"baselineId":1}']) {
        const post = await app.inject({
          method: 'POST',
          url: ACKNOWLEDGE,
          headers: { cookie, 'content-type': 'application/json' },
          payload,
        });
        expect(post.statusCode).toBe(404);
        expect(post.body).not.toContain('baseline');
      }
    }
    const { rows } = await sqlPool.query(`select count(*)::int as n from warden.schema_snapshots`);
    expect(rows[0].n).toBe(1);
  });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: DRIFT })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: ACKNOWLEDGE, payload: {} })).statusCode).toBe(
      401,
    );
  });

  it('reports schema changes after a restart, with a snippet that keeps current behavior', async () => {
    await sqlPool.query(`
      alter table users add column nickname text, add column ssn char(9);
      alter table orders add column shipped_at timestamptz;
      alter table companies drop column domain;
      create table invoices (id bigint primary key, amount numeric);
    `);
    await restart();

    const { drift } = await getDrift();
    expect(drift.addedTables).toEqual([{ table: 'invoices', exposed: true }]);
    expect(drift.addedColumns).toEqual([
      {
        table: 'orders',
        column: 'shipped_at',
        type: 'timestamp with time zone',
        treatment: 'visible',
      },
      { table: 'users', column: 'nickname', type: 'text', treatment: 'visible' },
      { table: 'users', column: 'ssn', type: 'character(9)', treatment: 'visible' },
    ]);
    expect(drift.removedColumns).toEqual([{ table: 'companies', column: 'domain' }]);
    // The example config makes companies searchable on the dropped column.
    expect(drift.warnings).toEqual([
      { path: 'tables.companies.searchable.1', message: 'column "domain" does not exist' },
    ]);
    expect(drift.snippet).toContain('  invoices: { hidden: false }\n');
    expect(drift.snippet).toContain('      ssn: { hidden: false }\n');
  });

  it('acknowledges the drift into a new, audited baseline', async () => {
    const { baseline } = await getDrift();

    const bad = await acknowledge('not-a-number');
    expect(bad.statusCode).toBe(400);
    const stale = await acknowledge(String(Number(baseline.id) + 1));
    expect(stale.statusCode).toBe(409);

    const res = await acknowledge(baseline.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<DriftBody>();
    expect(body.baseline).toMatchObject({ takenBy: 'admin' });
    expect(body.drift).toMatchObject({ addedTables: [], addedColumns: [], removedColumns: [] });
    // Config mismatches stay until config changes.
    expect(body.drift.warnings).toHaveLength(1);
    expect(await getDrift()).toEqual(body);

    const { rows } = await sqlPool.query(
      `select actor_subject, actor_roles, action, record_id, diff from warden.audit_log
       where entity = 'warden.schema_snapshots'`,
    );
    expect(rows).toEqual([
      {
        actor_subject: 'admin',
        actor_roles: ['admin', 'viewer'],
        action: 'acknowledge',
        record_id: body.baseline.id,
        diff: expect.objectContaining({
          addedTables: [{ table: 'invoices', exposed: true }],
        }),
      },
    ]);

    // Acknowledging the same baseline twice is a conflict, not a second entry.
    expect((await acknowledge(baseline.id)).statusCode).toBe(409);
  });
});
