import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  migrate,
  updateSavedView,
  type DatabaseHandle,
  type NewSavedView,
  type SavedView,
} from '../src/index.js';

let pgContainer: TestDatabase;
let handle: DatabaseHandle;

beforeAll(async () => {
  pgContainer = await startPostgres();
  handle = createDatabase({ connectionString: pgContainer.connectionString });
  await migrate(handle.db);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

const create = async (view: Partial<NewSavedView> = {}): Promise<SavedView> => {
  const result = await createSavedView(handle.db, {
    entity: 'users',
    name: 'Active',
    ownerSubject: 'ada',
    shared: false,
    state: { sort: '-created_at' },
    ...view,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.view;
};

describe('saved views', () => {
  it('stores a view and reads it back', async () => {
    const view = await create({ ownerName: 'Ada', state: { q: 'x', columns: ['id'] } });
    expect(view).toMatchObject({
      id: expect.stringMatching(/^\d+$/),
      entity: 'users',
      name: 'Active',
      ownerSubject: 'ada',
      ownerName: 'Ada',
      shared: false,
      state: { q: 'x', columns: ['id'] },
    });
    expect(await getSavedView(handle.db, view.id)).toEqual(view);
    expect(await getSavedView(handle.db, '999999')).toBeUndefined();
  });

  it('keeps names unique per owner and entity, ignoring case', async () => {
    await expect(createSavedView(handle.db, { ...base(), name: 'ACTIVE' })).resolves.toEqual({
      ok: false,
      reason: 'duplicate',
    });
    // Other owners and other entities may reuse it.
    await create({ ownerSubject: 'bob' });
    await create({ entity: 'orders' });
  });

  it("lists the subject's own views and everyone's shared ones for one entity", async () => {
    await create({ ownerSubject: 'bob', name: 'Bob shared', shared: true });
    await create({ ownerSubject: 'bob', name: 'Bob private' });
    const names = async (subject: string) =>
      (await listSavedViews(handle.db, { entity: 'users', subject })).map((v) => v.name);
    expect(await names('ada')).toEqual(['Active', 'Bob shared']);
    expect(await names('bob')).toEqual(['Active', 'Bob private', 'Bob shared']);
    expect(await names('carol')).toEqual(['Bob shared']);
  });

  it('updates only while sharing is as expected', async () => {
    const view = await create({ name: 'To update' });
    const updated = await updateSavedView(
      handle.db,
      view.id,
      { name: 'Updated', shared: true, state: { q: 'y' } },
      { expectShared: false },
    );
    expect(updated).toMatchObject({
      ok: true,
      view: { name: 'Updated', shared: true, state: { q: 'y' } },
    });
    expect(
      await updateSavedView(handle.db, view.id, { name: 'Again' }, { expectShared: false }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(
      await updateSavedView(handle.db, view.id, { name: 'active' }, { expectShared: true }),
    ).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('deletes only while sharing is as expected', async () => {
    const view = await create({ name: 'To delete', shared: true });
    expect(await deleteSavedView(handle.db, view.id, { expectShared: false })).toBe(false);
    expect(await deleteSavedView(handle.db, view.id, { expectShared: true })).toBe(true);
    expect(await getSavedView(handle.db, view.id)).toBeUndefined();
  });

  it('stores state as jsonb, so values are never interpolated', async () => {
    const payload = `'); drop table warden.saved_views; --`;
    const view = await create({ name: payload, state: { q: payload } });
    expect(await getSavedView(handle.db, view.id)).toMatchObject({
      name: payload,
      state: { q: payload },
    });
    const { rows } = await sql`select 1 from warden.saved_views`.execute(handle.db);
    expect(rows.length).toBeGreaterThan(0);
  });
});

function base(): NewSavedView {
  return { entity: 'users', name: 'Active', ownerSubject: 'ada', shared: false, state: {} };
}
