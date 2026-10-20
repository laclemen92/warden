import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWarden, parseDatabaseSettings } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';

const CONFIG = `
roles:
  ops: { grants: { '*': [read, export] } }
access:
  groups:
    warden-editors: [ops]
    warden-admins: [ops]
`;

// Far more CSV than socket buffers hold, so a client that stops reading stalls the export.
const SCHEMA = `
  create table wide (id int primary key, body text);
  insert into wide select i, repeat('x', 1000) from generate_series(1, 30000) as i;
`;

type User = 'editor' | 'admin';

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: Awaited<ReturnType<typeof createWarden>>;
let base: string;
const cookies = {} as Record<User, string>;

beforeAll(async () => {
  db = await startPostgres({ sql: [SCHEMA] });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  app = await createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: writeConfig(CONFIG),
      WARDEN_EXPORT_IDLE_TIMEOUT: '2s',
      WARDEN_EXPORT_MAX_CONCURRENT: '3',
      WARDEN_EXPORT_MAX_PER_USER: '2',
      ...authEnv(idp),
    },
  });
  for (const user of ['editor', 'admin'] as const) cookies[user] = await login(app, user);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

/** Start an export over a real socket and stop reading once it begins. */
function stall(user: User) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = get(
      `${base}/api/export/wide`,
      { headers: { cookie: cookies[user] }, agent: false },
      (res) => {
        res.pause();
        resolve(res);
      },
    );
    req.on('error', reject);
  });
}

/** Read the rest of a stalled response: whether it ended properly or was cut off. */
const finish = (res: IncomingMessage) =>
  new Promise<'complete' | 'aborted'>((resolve) => {
    res.on('end', () => resolve('complete'));
    res.on('error', () => resolve('aborted'));
    res.resume();
  });

const exportWide = (user: User, query: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: '/api/export/wide',
    query,
    headers: { cookie: cookies[user] },
  });

const openTransactions = async () =>
  Number(
    (
      await sqlPool.query(
        `select count(*) from pg_stat_activity
         where datname = current_database() and state like 'idle in transaction%'`,
      )
    ).rows[0].count,
  );

describe('export limits', () => {
  it('caps concurrent exports, keeps serving other requests, and ends stalled ones', async () => {
    const stalled = [await stall('admin'), await stall('admin')];
    for (const res of stalled) expect(res.statusCode).toBe(200);

    // Per user: a third from admin is refused, but editor may start one.
    const third = await exportWide('admin', {
      filter: JSON.stringify({ field: 'id', op: 'eq', value: 1 }),
    });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'too many exports are running; try again when one finishes',
    });
    stalled.push(await stall('editor'));
    expect(stalled[2]!.statusCode).toBe(200);
    // Globally: three are running, so editor's second is refused too.
    expect((await exportWide('editor')).statusCode).toBe(429);
    expect(await openTransactions()).toBe(3);

    // Stalled exports hold none of the main pool: sessions load and every other route answers.
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/entities/wide?limit=1',
        headers: { cookie: cookies.editor },
      });
      expect(res.statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/api/entities/wide' })).statusCode).toBe(401);

    // The idle timeout ends each stalled export's transaction...
    await expect.poll(openTransactions, { timeout: 5000 }).toBe(0);
    // ...and aborts its response, so the download fails rather than looking complete.
    expect(await Promise.all(stalled.map(finish))).toEqual(['aborted', 'aborted', 'aborted']);
    // Their slots are free again.
    const after = await exportWide('admin', {
      filter: JSON.stringify({ field: 'id', op: 'lte', value: 2 }),
      columns: 'id',
    });
    expect(after.statusCode).toBe(200);
    expect(after.body).toBe('﻿id\r\n1\r\n2\r\n');
  }, 30_000);

  it('frees the slot of an export refused for size or finished normally', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await exportWide('editor', {
        filter: JSON.stringify({ field: 'id', op: 'eq', value: i + 1 }),
        columns: 'id',
      });
      expect(res.statusCode).toBe(200);
    }
    expect(await openTransactions()).toBe(0);
  });
});

describe('parseDatabaseSettings', () => {
  it('has defaults', () => {
    expect(parseDatabaseSettings({})).toEqual({
      idleInTransactionTimeoutMs: 60_000,
      exports: {
        maxConcurrent: 4,
        maxPerUser: 2,
        idleTimeoutMs: 30_000,
        deadlineMs: 900_000,
      },
    });
  });

  it('reads durations and counts', () => {
    expect(
      parseDatabaseSettings({
        WARDEN_DB_IDLE_IN_TRANSACTION_TIMEOUT: '5m',
        WARDEN_EXPORT_IDLE_TIMEOUT: '90s',
        WARDEN_EXPORT_DEADLINE: '1h',
        WARDEN_EXPORT_MAX_CONCURRENT: '8',
        WARDEN_EXPORT_MAX_PER_USER: ' 1 ',
      }),
    ).toEqual({
      idleInTransactionTimeoutMs: 300_000,
      exports: { maxConcurrent: 8, maxPerUser: 1, idleTimeoutMs: 90_000, deadlineMs: 3_600_000 },
    });
  });

  it('rejects bad values', () => {
    for (const [name, value] of [
      ['WARDEN_DB_IDLE_IN_TRANSACTION_TIMEOUT', '0'],
      ['WARDEN_EXPORT_DEADLINE', 'soon'],
      ['WARDEN_EXPORT_MAX_CONCURRENT', '0'],
      ['WARDEN_EXPORT_MAX_PER_USER', '1.5'],
      ['WARDEN_EXPORT_MAX_CONCURRENT', '1000'],
    ] as const) {
      expect(() => parseDatabaseSettings({ [name]: value }), `${name}=${value}`).toThrow(name);
    }
    expect(() =>
      parseDatabaseSettings({
        WARDEN_EXPORT_IDLE_TIMEOUT: '1m',
        WARDEN_DB_IDLE_IN_TRANSACTION_TIMEOUT: '1m',
      }),
    ).toThrow(/WARDEN_EXPORT_IDLE_TIMEOUT must be shorter/);
  });
});
