import { wardenConfigSchema } from '@wardenhq/config';
import {
  decodeRecordId,
  resolveActor,
  resolveSchema,
  type ActorMapping,
  type Entity,
} from '@wardenhq/core';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createRow,
  deleteRow,
  introspect,
  lookupActorUserId,
  migrate,
  rowVersion,
  updateRow,
  type DatabaseHandle,
} from '../src/index.js';

const SCHEMA = `
  create table staff (
    id     uuid primary key default gen_random_uuid(),
    email  text,
    secret text default 'never read'
  );
  insert into staff (id, email) values
    ('00000000-0000-0000-0000-00000000000a', 'Ada@Example.com'),
    ('00000000-0000-0000-0000-00000000000b', 'twin@example.com'),
    ('00000000-0000-0000-0000-00000000000c', 'TWIN@example.com'),
    -- KELVIN SIGN, which lowercases to "k".
    ('00000000-0000-0000-0000-00000000000d', E'\\u212Aate@example.com');
  create table numbered (n bigint primary key, mail varchar(100));
  insert into numbered values (42, 'ada@example.com');

  create table notes (id serial primary key, body text);
  create table notes_log (
    id        serial primary key,
    op        text,
    actor_id  text,
    actor_sub text,
    actor_email text
  );
  create function log_note() returns trigger language plpgsql as $$
    begin
      insert into notes_log (op, actor_id, actor_sub, actor_email) values (
        tg_op,
        current_setting('warden.actor_id', true),
        current_setting('warden.actor_sub', true),
        current_setting('warden.actor_email', true));
      return coalesce(new, old);
    end;
  $$;
  create trigger notes_log after insert or update or delete on notes
    for each row execute function log_note();
`;

let pgContainer: TestDatabase;
let handle: DatabaseHandle;
let notes: Entity;
let staff: ActorMapping;

beforeAll(async () => {
  pgContainer = await startPostgres({ sql: [SCHEMA] });
  // One connection, so a setting that outlived its transaction would show up in the next one.
  handle = createDatabase({ connectionString: pgContainer.connectionString, maxConnections: 1 });
  await migrate(handle.db);
  const config = wardenConfigSchema.parse({
    tables: { staff: { hidden: true } },
    actor: { table: 'staff', matchColumn: 'email', idColumn: 'id' },
  });
  const model = await introspect(handle.pool);
  notes = resolveSchema(model, config).schema.entities.find((e) => e.key === 'notes')!;
  staff = resolveActor(model, config).mapping!;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

describe('lookupActorUserId', () => {
  it('finds a hidden table row by email, ignoring case, as text', async () => {
    expect(staff).toEqual({
      schema: 'public',
      table: 'staff',
      matchColumn: 'email',
      idColumn: 'id',
    });
    expect(await lookupActorUserId(handle.db, staff, 'ada@example.com')).toEqual({
      userId: '00000000-0000-0000-0000-00000000000a',
    });
    const numbered = { schema: 'public', table: 'numbered', matchColumn: 'mail', idColumn: 'n' };
    expect(await lookupActorUserId(handle.db, numbered, 'ada@example.com')).toEqual({
      userId: '42',
    });
  });

  it('gives no id for no match or several', async () => {
    expect(await lookupActorUserId(handle.db, staff, 'nobody@example.com')).toEqual({
      matches: 0,
    });
    expect(await lookupActorUserId(handle.db, staff, 'twin@example.com')).toEqual({
      matches: 'many',
    });
  });

  it("doesn't let a look-alike address in the table match", async () => {
    // Whether lower() folds it to "k" depends on the collation; either way it must not match.
    expect(await lookupActorUserId(handle.db, staff, 'kate@example.com')).toEqual({ matches: 0 });
  });

  it('treats the email as a value, never SQL', async () => {
    for (const email of [`' or true --`, `%`, `ada@example.com' or '1'='1`]) {
      expect(await lookupActorUserId(handle.db, staff, email)).toEqual({ matches: 0 });
    }
  });
});

describe('warden.actor_* settings', () => {
  const actor = {
    subject: 'sub-1',
    email: 'ada@example.com',
    userId: '00000000-0000-0000-0000-00000000000a',
  };
  const log = async () =>
    (
      await sql<{ op: string; actor_id: string; actor_sub: string; actor_email: string }>`
        select op, actor_id, actor_sub, actor_email from notes_log order by id`.execute(handle.db)
    ).rows;
  const outside = async () =>
    (
      await sql<{ id: string | null; sub: string | null; email: string | null }>`
        select current_setting('warden.actor_id', true) as id,
               current_setting('warden.actor_sub', true) as sub,
               current_setting('warden.actor_email', true) as email`.execute(handle.db)
    ).rows[0]!;

  it('are visible to triggers in every write and gone after it', async () => {
    const row = await createRow(handle.db, notes, { body: 'a' }, { actor });
    const decoded = decodeRecordId(notes, String(row.id));
    if (!decoded.ok) throw new Error(decoded.message);
    await updateRow(
      handle.db,
      notes,
      decoded.filter,
      { body: 'b' },
      {
        version: rowVersion(notes, row),
        actor,
      },
    );
    await deleteRow(handle.db, notes, decoded.filter, { actor });
    const expected = { actor_id: actor.userId, actor_sub: 'sub-1', actor_email: 'ada@example.com' };
    expect(await log()).toEqual([
      { op: 'INSERT', ...expected },
      { op: 'UPDATE', ...expected },
      { op: 'DELETE', ...expected },
    ]);

    // Same connection, outside the write's transaction: unset (empty once a transaction set it).
    const after = await outside();
    for (const value of Object.values(after)) expect(value ?? '').toBe('');
  });

  it('are empty for an actor without an id or email', async () => {
    await sql`truncate notes_log`.execute(handle.db);
    await createRow(handle.db, notes, { body: 'c' }, { actor: { subject: 'sub-2' } });
    expect(await log()).toEqual([
      { op: 'INSERT', actor_id: '', actor_sub: 'sub-2', actor_email: '' },
    ]);
  });

  it("aren't set by a write without an actor", async () => {
    await sql`truncate notes_log`.execute(handle.db);
    await createRow(handle.db, notes, { body: 'd' });
    const [entry] = await log();
    expect(entry?.actor_id ?? '').toBe('');
    expect(entry?.actor_sub ?? '').toBe('');
  });
});
