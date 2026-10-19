import type { Filter } from '@wardenhq/core';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileFilter, escapeLike } from '../src/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const offline = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const compile = (filter: Filter, table?: string) => {
  const { sql: text, parameters } = offline
    .selectFrom('users')
    .selectAll()
    .where(compileFilter(filter, table))
    .compile();
  return { where: text.replace('select * from "users" where ', ''), parameters };
};

describe('compileFilter SQL', () => {
  it.each<[Filter, string, unknown[]]>([
    [{ field: 'email', op: 'eq', value: 'a@b.c' }, '"email" = $1', ['a@b.c']],
    [{ field: 'role', op: 'neq', value: 'admin' }, '"role" is distinct from $1', ['admin']],
    [{ field: 'id', op: 'in', value: [1, 2, 3] }, '"id" in ($1, $2, $3)', [1, 2, 3]],
    [{ field: 'id', op: 'notIn', value: [1] }, '("id" is null or "id" not in ($1))', [1]],
    [{ field: 'total', op: 'gt', value: '10.5' }, '"total" > $1', ['10.5']],
    [{ field: 'total', op: 'lte', value: 3 }, '"total" <= $1', [3]],
    [{ field: 'id', op: 'between', value: [1, 9] }, '"id" between $1 and $2', [1, 9]],
    [{ field: 'email', op: 'contains', value: 'ada' }, '"email" ilike $1', ['%ada%']],
    [{ field: 'email', op: 'startsWith', value: 'ada' }, '"email" ilike $1', ['ada%']],
    [{ field: 'email', op: 'endsWith', value: '.io' }, '"email" ilike $1', ['%.io']],
    [{ field: 'notes', op: 'isNull' }, '"notes" is null', []],
    [{ field: 'notes', op: 'isNotNull' }, '"notes" is not null', []],
  ])('%j', (filter, where, parameters) => {
    expect(compile(filter)).toEqual({ where, parameters });
  });

  it('compiles nested boolean logic', () => {
    expect(
      compile({
        and: [
          { field: 'is_active', op: 'eq', value: true },
          {
            or: [
              { field: 'role', op: 'eq', value: 'admin' },
              { not: { field: 'email', op: 'isNull' } },
            ],
          },
        ],
      }),
    ).toEqual({
      where: '("is_active" = $1 and ("role" = $2 or not "email" is null))',
      parameters: [true, 'admin'],
    });
  });

  it('qualifies columns with a table when given', () => {
    expect(compile({ field: 'email', op: 'eq', value: 'x' }, 'users').where).toBe(
      '"users"."email" = $1',
    );
  });

  it('never puts values in SQL text', () => {
    const payload = "'; drop table users; --";
    const { where, parameters } = compile({
      or: [
        { field: 'email', op: 'eq', value: payload },
        { field: 'email', op: 'contains', value: payload },
        { field: 'email', op: 'in', value: [payload, payload] },
      ],
    });
    expect(where).not.toContain('drop');
    expect(parameters).toEqual([payload, `%${escapeLike(payload)}%`, payload, payload]);
  });

  it('quotes identifiers even if an unvalidated name slips through', () => {
    expect(compile({ field: 'a"; drop table users; --', op: 'isNull' }).where).toBe(
      '"a""; drop table users; --" is null',
    );
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(compile({ field: 'notes', op: 'contains', value: '100%' }).parameters).toEqual([
      '%100\\%%',
    ]);
  });
});

const since = new Date(Date.now() - 3600_000).toISOString();

describe('compileFilter against Postgres', () => {
  let db: TestDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kysely: Kysely<any>;

  beforeAll(async () => {
    db = await startPostgres({
      sql: [
        await readExampleSql('basic/schema.sql'),
        await readExampleSql('basic/seed.sql'),
        `insert into orders (company_id, status, total, notes) values
           (1, 'paid', 1, '100% off'), (1, 'paid', 1, '100 off'), (1, 'paid', 1, 'under_score')`,
      ],
    });
    kysely = new Kysely({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: db.connectionString }),
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await kysely?.destroy();
    await db?.stop();
  });

  const count = async (table: string, filter: Filter) => {
    const row = await kysely
      .selectFrom(table)
      .select(sql<string>`count(*)`.as('n'))
      .where(compileFilter(filter))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  };
  const countWhere = async (table: string, where: string) => {
    const { rows } = await sql<{
      n: string;
    }>`select count(*) as n from ${sql.table(table)} where ${sql.raw(where)}`.execute(kysely);
    return Number(rows[0]?.n);
  };

  it.each<[string, Filter, string]>([
    ['orders', { field: 'status', op: 'eq', value: 'paid' }, `status = 'paid'`],
    [
      'orders',
      { field: 'status', op: 'in', value: ['shipped', 'refunded'] },
      `status in ('shipped', 'refunded')`,
    ],
    ['orders', { field: 'user_id', op: 'neq', value: '5' }, `user_id is distinct from 5`],
    [
      'orders',
      { field: 'user_id', op: 'notIn', value: [5, 6] },
      `user_id is null or user_id not in (5, 6)`,
    ],
    [
      'orders',
      { field: 'total', op: 'between', value: ['100', '200.50'] },
      `total between 100 and 200.50`,
    ],
    ['orders', { field: 'placed_at', op: 'gte', value: since }, `placed_at >= '${since}'`],
    ['users', { field: 'email', op: 'contains', value: 'COMPANY7.' }, `email ilike '%company7.%'`],
    ['users', { field: 'last_login_at', op: 'isNull' }, `last_login_at is null`],
    [
      'users',
      {
        and: [
          { field: 'is_active', op: 'eq', value: false },
          { field: 'role', op: 'eq', value: 'owner' },
        ],
      },
      `not is_active and role = 'owner'`,
    ],
  ])('%s %j', async (table, filter, where) => {
    const expected = await countWhere(table, where);
    expect(expected).toBeGreaterThan(0);
    expect(await count(table, filter)).toBe(expected);
  });

  it('matches LIKE wildcards literally', async () => {
    expect(await count('orders', { field: 'notes', op: 'contains', value: '100%' })).toBe(1);
    // Unescaped, `_` would match the space in "100 off".
    expect(await count('orders', { field: 'notes', op: 'contains', value: '0_o' })).toBe(0);
    expect(await countWhere('orders', `notes ilike '%0_o%'`)).toBeGreaterThan(0);
  });

  it('treats injection payloads as plain values', async () => {
    expect(await count('users', { field: 'email', op: 'eq', value: "' or '1'='1" })).toBe(0);
    expect(
      await count('users', { field: 'email', op: 'contains', value: "'); drop table users; --" }),
    ).toBe(0);
    expect(await countWhere('users', 'true')).toBe(500);
  });
});
