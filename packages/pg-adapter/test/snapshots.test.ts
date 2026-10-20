import type { SchemaModel } from '@wardenhq/core';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acknowledgeSchemaSnapshot,
  createDatabase,
  ensureSchemaSnapshot,
  latestSchemaSnapshot,
  migrate,
  type DatabaseHandle,
} from '../src/index.js';

let pgContainer: TestDatabase;
let handle: DatabaseHandle;

const model = (...names: string[]): SchemaModel => ({
  enums: [],
  tables: names.map((name) => ({
    schema: 'public',
    name,
    kind: 'table',
    columns: [],
    primaryKey: [],
    uniqueKeys: [],
    foreignKeys: [],
  })),
});
const actor = { subject: 'admin', email: 'admin@example.com', roles: ['admin'], requestId: 'r1' };

beforeAll(async () => {
  pgContainer = await startPostgres();
  handle = createDatabase({ connectionString: pgContainer.connectionString });
  await migrate(handle.db);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

describe('schema snapshots', () => {
  it('records the first baseline once, even when replicas start together', async () => {
    expect(await latestSchemaSnapshot(handle.db)).toBeUndefined();
    const results = await Promise.all([
      ensureSchemaSnapshot(handle.db, model('users')),
      ensureSchemaSnapshot(handle.db, model('users')),
      ensureSchemaSnapshot(handle.db, model('other')),
    ]);
    expect(new Set(results.map((s) => s.id)).size).toBe(1);
    const { rows } = await sql`select 1 from warden.schema_snapshots`.execute(handle.db);
    expect(rows).toHaveLength(1);
    expect(results[0]).toMatchObject({ takenBy: null, model: model('users') });
  });

  it('acknowledges into a new baseline and audits it', async () => {
    const baseline = await ensureSchemaSnapshot(handle.db, model('ignored'));
    const drift = { addedTables: [{ table: 'orders', exposed: true }] };
    const next = await acknowledgeSchemaSnapshot(handle.db, {
      model: model('users', 'orders'),
      expectedId: baseline.id,
      actor,
      drift,
    });
    expect(next).toMatchObject({ takenBy: 'admin', model: model('users', 'orders') });
    expect(await latestSchemaSnapshot(handle.db)).toEqual(next);

    const { rows } = await sql<Record<string, unknown>>`
      select request_id, actor_subject, actor_email, actor_roles, action, entity, record_id,
             before, after, diff
      from warden.audit_log where entity = 'warden.schema_snapshots'`.execute(handle.db);
    expect(rows).toEqual([
      {
        request_id: 'r1',
        actor_subject: 'admin',
        actor_email: 'admin@example.com',
        actor_roles: ['admin'],
        action: 'acknowledge',
        entity: 'warden.schema_snapshots',
        record_id: next!.id,
        before: { baseline: baseline.id },
        after: { baseline: next!.id },
        diff: drift,
      },
    ]);
  });

  it('refuses a stale acknowledgement without writing anything', async () => {
    const current = (await latestSchemaSnapshot(handle.db))!;
    const count = async () =>
      (await sql`select 1 from warden.audit_log`.execute(handle.db)).rows.length;
    const audited = await count();

    const stale = String(Number(current.id) - 1);
    const results = await Promise.all([
      acknowledgeSchemaSnapshot(handle.db, { model: model(), expectedId: stale, actor, drift: {} }),
      acknowledgeSchemaSnapshot(handle.db, {
        model: model(),
        expectedId: current.id,
        actor,
        drift: {},
      }),
      acknowledgeSchemaSnapshot(handle.db, {
        model: model(),
        expectedId: current.id,
        actor,
        drift: {},
      }),
    ]);
    // Only one of two concurrent acknowledgements of the same baseline wins.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await count()).toBe(audited + 1);
  });
});
