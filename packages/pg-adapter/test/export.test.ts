import { wardenConfigSchema } from '@wardenhq/config';
import { resolveSchema, resolveSort, type Entity } from '@wardenhq/core';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditWriteError,
  createDatabase,
  introspect,
  listAuditEntries,
  migrate,
  openExport,
  recordExport,
  type DatabaseHandle,
  type Row,
} from '../src/index.js';

const SCHEMA = `
  create table accounts (
    id      int primary key,
    name    text,
    secret  text default 's3cret'
  );
  insert into accounts (id, name) select i, 'n' || (i % 3) from generate_series(1, 7) as i;
  create table logs (line text);
  insert into logs values ('b'), ('a'), (null);
`;

let pgContainer: TestDatabase;
let handle: DatabaseHandle;
let accounts: Entity;
let logs: Entity;

beforeAll(async () => {
  pgContainer = await startPostgres({ sql: [SCHEMA] });
  handle = createDatabase({ connectionString: pgContainer.connectionString, maxConnections: 2 });
  await migrate(handle.db);
  const config = wardenConfigSchema.parse({
    tables: { accounts: { columns: { secret: { hidden: true } } } },
  });
  const { schema } = resolveSchema(await introspect(handle.pool), config);
  accounts = schema.entities.find((e) => e.key === 'accounts')!;
  logs = schema.entities.find((e) => e.key === 'logs')!;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

const sortOf = (entity: Entity, input?: string) => {
  const sort = resolveSort(entity, input);
  if (!sort.ok) throw new Error(sort.message);
  return sort.sort;
};

async function readAll(rows: AsyncIterable<Row[]>) {
  const batches: Row[][] = [];
  for await (const batch of rows) batches.push(batch);
  return batches;
}

describe('openExport', () => {
  it('streams the matching rows in order, in batches, like the equivalent query', async () => {
    const result = await openExport(handle.db, accounts, {
      filter: { field: 'name', op: 'neq', value: 'n0' },
      sort: sortOf(accounts, '-name'),
      batchSize: 2,
    });
    const batches = await readAll(result.batches());
    const { rows: expected } = await sql<Row>`
      select id, name from accounts where name <> 'n0' order by name desc nulls last, id asc`.execute(
      handle.db,
    );
    expect(result.total).toBe(expected.length);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(batches.flat()).toEqual(expected);
  });

  it('never selects hidden columns', async () => {
    const result = await openExport(handle.db, accounts, { sort: sortOf(accounts) });
    const rows = (await readAll(result.batches())).flat();
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'name']);
  });

  it('exports tables without a primary key', async () => {
    const result = await openExport(handle.db, logs, { sort: sortOf(logs, 'line') });
    expect(result.total).toBe(3);
    expect((await readAll(result.batches())).flat()).toEqual([
      { line: 'a' },
      { line: 'b' },
      { line: null },
    ]);
  });

  it('reads one snapshot: rows written after it opens are not included', async () => {
    const result = await openExport(handle.db, logs, { sort: sortOf(logs), batchSize: 1 });
    await sql`insert into logs values ('late')`.execute(handle.db);
    try {
      expect((await readAll(result.batches())).flat()).toHaveLength(result.total);
      expect(result.total).toBe(3);
    } finally {
      await sql`delete from logs where line = 'late'`.execute(handle.db);
    }
  });

  it('binds filter values instead of interpolating them', async () => {
    const result = await openExport(handle.db, logs, {
      sort: sortOf(logs),
      filter: { field: 'line', op: 'eq', value: "x'); delete from logs; --" },
    });
    expect(result.total).toBe(0);
    expect((await readAll(result.batches())).flat()).toEqual([]);
    const { rows } = await sql`select 1 from logs`.execute(handle.db);
    expect(rows).toHaveLength(3);
  });

  it('gives its connection back when closed early or abandoned', async () => {
    // With a pool of two, leaking connections would hang the third export.
    for (let i = 0; i < 4; i++) {
      const result = await openExport(handle.db, accounts, {
        sort: sortOf(accounts),
        batchSize: 1,
      });
      if (i % 2 === 0) {
        await result.close();
        await result.close();
      } else {
        for await (const batch of result.batches()) {
          expect(batch).toHaveLength(1);
          break;
        }
      }
    }
    expect(handle.pool.idleCount).toBe(handle.pool.totalCount);
  });
});

describe('recordExport', () => {
  const actor = { subject: 'sub-1', email: 'ed@example.com', roles: ['analyst'] };

  it('appends an export entry with its details', async () => {
    const details = {
      rowCount: 6,
      columns: ['id', 'name'],
      filter: { field: 'name', op: 'eq' as const, value: 'n1' },
      sort: '-name',
    };
    await recordExport(handle.db, { actor, requestId: 'req-9', entity: accounts, details });
    const { entries } = await listAuditEntries(handle.db, {
      visible: { accounts: ['id', 'name'] },
      limit: 10,
    });
    expect(entries[0]).toMatchObject({
      action: 'export',
      entity: 'accounts',
      recordId: null,
      requestId: 'req-9',
      actor: { subject: 'sub-1', email: 'ed@example.com', roles: ['analyst'] },
      before: null,
      after: null,
      diff: {},
      details,
    });
  });

  it("leaves out details naming fields the reader can't see", async () => {
    await recordExport(handle.db, {
      actor,
      entity: accounts,
      details: { rowCount: 7, columns: ['id', 'name'], sort: 'name' },
    });
    const { entries } = await listAuditEntries(handle.db, {
      visible: { accounts: ['id'] },
      limit: 1,
    });
    expect(entries[0]!.details).toEqual({ rowCount: 7, columns: ['id'], redacted: true });
  });

  it('fails with an AuditWriteError when the entry cannot be written', async () => {
    const closed = createDatabase({ connectionString: pgContainer.connectionString });
    await closed.close();
    await expect(
      recordExport(closed.db, { actor, entity: accounts, details: { rowCount: 0, columns: [] } }),
    ).rejects.toBeInstanceOf(AuditWriteError);
  });
});
