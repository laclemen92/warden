import { wardenConfigSchema } from '@wardenhq/config';
import { resolveSchema, validateRecord, type Entity } from '@wardenhq/core';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, introspect, mapWriteError, type DatabaseHandle } from '../src/index.js';

const SCHEMA = `
  create table values_test (
    id     int generated always as identity primary key,
    code   varchar(3),
    label  char(2),
    small  int2,
    big    int8,
    price  numeric(5, 2),
    frac   numeric(2, 2),
    whole  numeric(3),
    ratio  float8,
    day    date,
    at     timestamptz,
    clock  time,
    uid    uuid,
    tags   varchar(2)[]
  );

  create table teams (
    id    int primary key,
    name  text not null unique
  );

  create table members (
    id        int primary key,
    team_id   int not null references teams (id),
    slot      int not null check (slot > 0),
    email     text not null,
    secret    text,
    unique (team_id, slot),
    constraint members_secret_check check (secret <> 'bad')
  );
  create unique index members_email_key on members (lower(email));
  create unique index members_secret_key on members (secret);

  insert into teams values (1, 'Red');
  insert into members values (1, 1, 1, 'a@example.com', 's1');
`;

let pgContainer: TestDatabase;
let handle: DatabaseHandle;
let entities: Map<string, Entity>;

beforeAll(async () => {
  pgContainer = await startPostgres({ sql: [SCHEMA] });
  handle = createDatabase({ connectionString: pgContainer.connectionString });
  const config = wardenConfigSchema.parse({
    tables: { members: { columns: { secret: { hidden: true } } } },
  });
  const { schema } = resolveSchema(await introspect(handle.pool), config);
  entities = new Map(schema.entities.map((e) => [e.key, e]));
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await pgContainer?.stop();
});

const entity = (key: string) => {
  const e = entities.get(key);
  if (!e) throw new Error(`entity ${key} not found`);
  return e;
};

/** Run a write and return the mapped error (or the raw error if it isn't mapped). */
async function failingWrite(
  key: string,
  query: ReturnType<typeof sql>,
  operation: 'create' | 'update' | 'delete' = 'create',
) {
  try {
    await query.execute(handle.db);
  } catch (err) {
    return (await mapWriteError(handle.db, entity(key), err, operation)) ?? err;
  }
  throw new Error('expected the write to fail');
}

describe('validateRecord agrees with Postgres', () => {
  // Each value is checked by validateRecord and by inserting it; both must accept or reject it.
  it.each<[string, unknown]>([
    ['code', 'abc'],
    ['code', 'abcd'],
    ['code', '😀😀😀'],
    ['code', '😀😀😀😀'],
    ['code', 'a\u0000'],
    ['label', 'ab'],
    ['label', 'abc'],
    ['small', 32767],
    ['small', 32768],
    ['small', '-32768'],
    ['small', '-32769'],
    ['small', 1.5],
    ['big', '9223372036854775807'],
    ['big', '9223372036854775808'],
    ['big', '-9223372036854775808'],
    ['price', 999.99],
    ['price', '999.994'],
    ['price', 1000],
    ['price', '1e2'],
    ['price', '1e3'],
    ['price', '-0.001'],
    ['price', '00012.5'],
    ['frac', '0.99'],
    ['frac', 1],
    ['whole', '999'],
    ['whole', '999.4'],
    ['whole', 1000],
    ['ratio', '1.5e300'],
    ['ratio', 'abc'],
    ['day', '2026-01-02'],
    ['day', '2026-13-01'],
    ['day', '2024-02-29'],
    ['day', '2025-02-29'],
    ['day', '0099-04-31'],
    ['day', '0000-01-01'],
    ['at', '2026-01-02 03:04:05.123456+00'],
    ['at', '2026-01-02T03:04:05Z'],
    ['at', '2026-01-02'],
    ['at', '2026-01-02 25:00'],
    ['clock', '03:04:05'],
    ['clock', '03:04'],
    ['clock', '24:00:00'],
    ['clock', '24:00:01'],
    ['clock', '12:60'],
    ['clock', '3pm'],
    ['uid', '4b9e8a1c-1f0e-4c1a-9d3e-0a1b2c3d4e5f'],
    ['uid', 'not-a-uuid'],
    ['tags', ['ab', null]],
    ['tags', ['abc']],
  ])('%s = %j', async (field, value) => {
    const valid = validateRecord(entity('values_test'), { [field]: value }, 'create').ok;
    const accepted = await sql`insert into values_test (${sql.id(field)}) values (${value})`
      .execute(handle.db)
      .then(
        () => true,
        () => false,
      );
    expect(valid).toBe(accepted);
  });

  // Postgres also accepts special values and loose formats; the API only takes ISO 8601.
  it.each<[string, unknown]>([
    ['day', 'tomorrow'],
    ['at', 'now'],
    ['clock', 'allballs'],
  ])('rejects %s = %j, which Postgres would accept', async (field, value) => {
    expect(validateRecord(entity('values_test'), { [field]: value }, 'create').ok).toBe(false);
    await sql`insert into values_test (${sql.id(field)}) values (${value})`.execute(handle.db);
  });
});

describe('mapWriteError', () => {
  it('maps a not-null violation to the field', async () => {
    expect(
      await failingWrite('members', sql`insert into members (id, team_id, slot) values (2, 1, 2)`),
    ).toEqual({ status: 400, errors: [{ field: 'email', message: 'is required' }] });
  });

  it('maps a unique violation to its field', async () => {
    expect(await failingWrite('teams', sql`insert into teams values (2, 'Red')`)).toEqual({
      status: 409,
      errors: [{ field: 'name', message: 'is already in use' }],
    });
  });

  it('maps a multi-column unique violation to each field', async () => {
    expect(
      await failingWrite(
        'members',
        sql`insert into members (id, team_id, slot, email) values (2, 1, 1, 'b@example.com')`,
      ),
    ).toEqual({
      status: 409,
      errors: [
        { field: 'team_id', message: 'is already in use together with slot' },
        { field: 'slot', message: 'is already in use together with team_id' },
      ],
    });
  });

  it('reports an expression unique index against the record', async () => {
    expect(
      await failingWrite(
        'members',
        sql`insert into members (id, team_id, slot, email) values (2, 1, 2, 'A@example.com')`,
      ),
    ).toEqual({ status: 409, errors: [{ message: 'conflicts with an existing record' }] });
  });

  it('maps a missing foreign key target to the field', async () => {
    expect(
      await failingWrite(
        'members',
        sql`insert into members (id, team_id, slot, email) values (2, 99, 1, 'b@example.com')`,
      ),
    ).toEqual({
      status: 400,
      errors: [{ field: 'team_id', message: 'references a record that does not exist' }],
    });
  });

  it('reports a delete of a referenced row as a conflict', async () => {
    expect(await failingWrite('teams', sql`delete from teams where id = 1`, 'delete')).toEqual({
      status: 409,
      errors: [{ message: 'is referenced by other records' }],
    });
  });

  it('maps a check violation to the field', async () => {
    expect(await failingWrite('members', sql`update members set slot = 0 where id = 1`)).toEqual({
      status: 400,
      errors: [{ field: 'slot', message: 'violates check constraint "members_slot_check"' }],
    });
  });

  it('never names hidden columns', async () => {
    const results = [
      await failingWrite('members', sql`update members set secret = 'bad' where id = 1`, 'update'),
      await failingWrite(
        'members',
        sql`insert into members values (2, 1, 2, 'b@example.com', 's1')`,
      ),
    ];
    expect(results).toEqual([
      { status: 400, errors: [{ message: 'violates a check constraint' }] },
      { status: 409, errors: [{ message: 'conflicts with an existing record' }] },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/secret/);
  });

  it('maps data errors without echoing values', async () => {
    expect(
      await failingWrite('values_test', sql`insert into values_test (code) values ('abcdef')`),
    ).toEqual({ status: 400, errors: [{ message: 'a value is too long for its field' }] });
    expect(
      await failingWrite('values_test', sql`insert into values_test (day) values ('2026-02-30')`),
    ).toEqual({ status: 400, errors: [{ message: 'a date/time value is out of range' }] });
  });

  it('leaves other errors unmapped', async () => {
    const err = await failingWrite('teams', sql`select * from no_such_table`);
    expect(err).toBeInstanceOf(Error);
    expect(await mapWriteError(handle.db, entity('teams'), new Error('boom'), 'create')).toBe(
      undefined,
    );
  });
});
