import { wardenConfigSchema } from '@wardenhq/config';
import {
  ActionLimitError,
  ActionPermissionError,
  ActionValidationError,
  type ActionTx,
} from '@wardenhq/actions';
import { resolveSchema, type Entity } from '@wardenhq/core';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionWriteError,
  auditHook,
  createActionTx,
  createDatabase,
  insertActionEntry,
  introspect,
  migrate,
  type ActionTxOptions,
  type DatabaseHandle,
  type WriteChange,
} from '../src/index.js';

const SCHEMA = `
  create table things (
    id      int generated always as identity primary key,
    name    text not null,
    kind    text not null default 'plain',
    secret  text default 'hidden',
    unique (name)
  );
  create table notes (body text);
  create table vault (id int primary key);
`;

let pgContainer: TestDatabase;
let handle: DatabaseHandle;
let entities: Map<string, Entity>;

const actor = { subject: 'tester', roles: ['ops'] };

beforeAll(async () => {
  pgContainer = await startPostgres({ sql: [SCHEMA] });
  handle = createDatabase({ connectionString: pgContainer.connectionString });
  await migrate(handle.db);
  const config = wardenConfigSchema.parse({
    tables: { things: { columns: { secret: { hidden: true } } }, vault: { hidden: true } },
  });
  const { schema } = resolveSchema(await introspect(handle.pool), config);
  entities = new Map(schema.entities.map((e) => [e.key, e]));
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

beforeEach(async () => {
  await sql`truncate things restart identity`.execute(handle.db);
  await sql`insert into things (name, kind) select 'thing ' || g, case when g <= 3 then 'odd' else 'plain' end
            from generate_series(1, 5) g`.execute(handle.db);
});

const rows = async () =>
  (
    await sql<{ id: number; name: string; kind: string; secret: string }>`
    select * from things order by id`.execute(handle.db)
  ).rows;
const auditRows = async () =>
  (
    await sql<{ id: string; parent_id: string | null; action: string; record_id: string }>`
    select id, parent_id, action, record_id from warden.audit_log order by id`.execute(handle.db)
  ).rows;

/** Run `fn` with a tx in one transaction, as the server does, auditing under a parent entry. */
async function withTx<T>(
  fn: (tx: ActionTx, changes: WriteChange[]) => Promise<T>,
  options: Partial<ActionTxOptions> = {},
) {
  return handle.db.transaction().execute(async (trx) => {
    const parentId = await insertActionEntry(trx, {
      actor,
      action: 'test-action',
      entity: entities.get('things')!,
      details: { input: {}, records: [] },
    });
    const audit = auditHook({ actor, parentId });
    const changes: WriteChange[] = [];
    const tx = createActionTx(trx, {
      action: 'test-action',
      resolve: (table) => entities.get(table),
      permissions: { things: ['create', 'update', 'delete'] },
      maxAffectedRows: 100,
      onWrite: async (t, change) => {
        await audit(t, change);
        changes.push(change);
      },
      ...options,
    });
    return fn(tx, changes);
  });
}

describe('createActionTx', () => {
  it('writes through the CRUD path, auditing each row under the parent', async () => {
    const before = await auditRows();
    const created = await withTx(async (tx) => {
      const made = await tx.create('things', { name: 'new' });
      await tx.update('things', made, { kind: 'special' });
      await tx.delete('things', '1');
      return made;
    });
    expect(created).toEqual({
      entity: 'things',
      id: '6',
      label: 'new',
      values: { id: 6, name: 'new', kind: 'plain' },
    });
    expect(await rows()).toEqual(
      expect.arrayContaining([{ id: 6, name: 'new', kind: 'special', secret: 'hidden' }]),
    );
    expect((await rows()).some((r) => r.id === 1)).toBe(false);
    const added = (await auditRows()).slice(before.length);
    const [parent, ...children] = added;
    expect(parent).toMatchObject({ action: 'test-action', parent_id: null });
    expect(children.map((c) => [c.action, c.record_id, c.parent_id])).toEqual([
      ['create', '6', parent!.id],
      ['update', '6', parent!.id],
      ['delete', '1', parent!.id],
    ]);
  });

  it('updates and deletes by filter like the equivalent SQL, row by row', async () => {
    const expected = (
      await sql<{ id: number }>`select id from things where kind = 'odd' order by id`.execute(
        handle.db,
      )
    ).rows.map((r) => r.id);
    const changes = await withTx(async (tx, changes) => {
      expect(
        await tx.updateMany('things', { field: 'kind', op: 'eq', value: 'odd' }, { kind: 'even' }),
      ).toBe(expected.length);
      expect(await tx.deleteMany('things', { field: 'kind', op: 'eq', value: 'even' })).toBe(
        expected.length,
      );
      expect(
        await tx.updateMany('things', { field: 'kind', op: 'eq', value: 'none' }, { kind: 'x' }),
      ).toBe(0);
      return changes;
    });
    expect(changes.map((c) => [c.action, (c.after ?? c.before)!.id])).toEqual([
      ...expected.map((id) => ['update', id]),
      ...expected.map((id) => ['delete', id]),
    ]);
    expect((await rows()).map((r) => r.id)).toEqual([4, 5]);
  });

  it('reads visible fields only, and finds nothing for missing or malformed ids', async () => {
    await withTx(async (tx) => {
      const thing = await tx.get('things', '2');
      expect(Object.keys(thing!.values)).toEqual(['id', 'name', 'kind']);
      expect(await tx.get('things', '999')).toBeNull();
      expect(await tx.get('things', 'abc')).toBeNull();
      expect(await tx.get('things', '1 or 1=1')).toBeNull();
      const listed = await tx.list('things', {
        filter: { field: 'kind', op: 'eq', value: 'odd' },
        sort: '-id',
        limit: 2,
      });
      expect(listed.map((r) => r.id)).toEqual(['3', '2']);
    });
  });

  it('rejects hidden tables and columns exactly like nonexistent ones', async () => {
    const fails = (fn: (tx: ActionTx) => Promise<unknown>) =>
      withTx(fn).then(
        () => undefined,
        (err: unknown) => err as ActionValidationError,
      );
    const vault = await fails((tx) => tx.list('vault'));
    const nothing = await fails((tx) => tx.list('nothing'));
    expect(vault).toBeInstanceOf(ActionValidationError);
    expect(vault?.message).toBe('unknown entity "vault"');
    expect(nothing?.message).toBe('unknown entity "nothing"');

    const hiddenWrite = await fails((tx) => tx.update('things', '1', { secret: 'x' }));
    const missingWrite = await fails((tx) => tx.update('things', '1', { nope: 'x' }));
    expect(hiddenWrite?.errors).toEqual([{ field: 'secret', message: 'unknown field "secret"' }]);
    expect(missingWrite?.errors).toEqual([{ field: 'nope', message: 'unknown field "nope"' }]);

    const hiddenFilter = await fails((tx) =>
      tx.deleteMany('things', { field: 'secret', op: 'isNull' }),
    );
    expect(hiddenFilter?.errors).toEqual([{ message: 'unknown field "secret"' }]);
    // Read-only and create-only fields can't be written either.
    const readOnly = await fails((tx) => tx.update('things', '1', { id: 9 }));
    expect(readOnly?.errors).toEqual([{ field: 'id', message: 'is read-only' }]);
    expect((await rows()).find((r) => r.id === 1)?.secret).toBe('hidden');
  });

  it('refuses writes outside the permissions, and past the row cap', async () => {
    const outside = await withTx((tx) => tx.delete('things', '1'), {
      permissions: { things: ['update'] },
    }).catch((err: unknown) => err);
    expect(outside).toBeInstanceOf(ActionPermissionError);

    const capped = await withTx(
      async (tx) => {
        await tx.update('things', '1', { kind: 'a' });
        await tx.updateMany('things', { field: 'id', op: 'gt', value: 1 }, { kind: 'b' });
      },
      { maxAffectedRows: 3 },
    ).catch((err: unknown) => err);
    expect(capped).toBeInstanceOf(ActionLimitError);
    // The transaction rolled back, so nothing changed.
    expect((await rows()).map((r) => r.kind)).toEqual(['odd', 'odd', 'odd', 'plain', 'plain']);
  });

  it('tags constraint violations with the write that caused them', async () => {
    const err = await withTx((tx) => tx.create('things', { name: 'thing 1' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ActionWriteError);
    expect(err).toMatchObject({ operation: 'create', entity: { key: 'things' } });
  });

  it('rolls everything back, the parent entry included, when an audit insert fails', async () => {
    const before = await auditRows();
    const err = await withTx(
      async (tx) => {
        await tx.update('things', '1', { kind: 'audited' });
        await tx.update('things', '2', { kind: 'not audited' });
      },
      {
        onWrite: async (_trx, change) => {
          if (change.after?.kind === 'not audited') throw new Error('audit insert failed');
        },
      },
    ).catch((e: unknown) => e);
    expect(err).toEqual(new Error('audit insert failed'));
    expect((await rows()).map((r) => r.kind)).toEqual(['odd', 'odd', 'odd', 'plain', 'plain']);
    expect(await auditRows()).toEqual(before);
  });
});
