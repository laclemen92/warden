import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWardenRequest } from '../../../docs/examples/verify-warden-request.mjs';
import { ActionsError } from '../src/actions.js';
import {
  MAX_CONTEXT_RECORD_BYTES,
  runHttpAction,
  type HttpAction,
  type UserTokenProvider,
} from '../src/http-actions.js';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';
import type { MockOidc } from '@wardenhq/mock-oidc';

const ACTIONS = fileURLToPath(new URL('./fixtures/http-actions.js', import.meta.url));
const SECRET = 'test-hmac-secret-0123456789';
const CLIENT_SECRET = 'm2m-client-secret-xyz';
const M2M_TOKEN = 'm2m-access-token';
const REASON = 'checking the API call';

const CONFIG = `
defaults: { read: granted }
roles:
  viewer: { grants: { '*': [read] } }
  ops:
    grants: { users: [read], companies: [read] }
    actions: [review-user, review-many, review-slow, review-batch, m2m-ping, as-user, off-site]
  admin:
    grants: { '*': [read] }
    admin: [audit]
    actions: [as-user]
access:
  groups:
    warden-viewers: [viewer]
    warden-editors: [ops]
    warden-admins: [admin]
`;

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
interface Reply {
  status: number;
  body?: unknown;
  contentType?: string;
  delayMs?: number;
  headers?: Record<string, string>;
}

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let api: Server;
let apiUrl: string;
let app: Awaited<ReturnType<typeof createWarden>>;
let ops: string;
let viewer: string;
let admin: string;
const received: Received[] = [];
let respond: (req: Received) => Reply = () => ({ status: 200, body: {} });
const logLines: string[] = [];

// Shaped like the session store's error: recognized by name, not class.
class SessionSignInAgainError extends Error {
  override name = 'SignInAgainError';
}

const userTokens: UserTokenProvider = {
  audience: 'https://api.test',
  accessTokenFor: async (req) => {
    // The admin's refresh token has been revoked, say.
    if (req.session?.subject === 'admin') throw new SessionSignInAgainError('refresh rejected');
    return `user-token-${req.session?.subject}`;
  },
};

const baseEnv = () => ({
  DATABASE_URL: db.connectionString,
  WARDEN_CONFIG: writeConfig(CONFIG),
  WARDEN_ACTIONS: ACTIONS,
  TEST_HMAC_SECRET: SECRET,
  TEST_CLIENT_ID: 'warden-m2m',
  TEST_CLIENT_SECRET: CLIENT_SECRET,
  ...authEnv(idp),
});

beforeAll(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(entry);
      const reply = respond(entry);
      setTimeout(() => {
        if (res.destroyed) return;
        const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
        res.writeHead(reply.status, {
          'content-type': reply.contentType ?? 'application/json',
          ...reply.headers,
        });
        res.end(text);
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  (globalThis as { __wardenTestApi?: string }).__wardenTestApi = apiUrl;

  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  app = await createWarden({ env: baseEnv(), userTokens, logger: { level: 'debug', stream } });
  ops = await login(app, 'editor');
  viewer = await login(app, 'viewer');
  admin = await login(app, 'admin');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
  api?.closeAllConnections();
  await new Promise((resolve) => api?.close(resolve));
});

beforeEach(() => {
  received.splice(0);
  respond = () => ({ status: 200, body: {} });
});

const send = async (url: string, cookie: string, payload: object = {}) => {
  const body = 'reason' in payload ? payload : { ...payload, reason: REASON };
  const res = await app.inject({ method: 'POST', url, headers: { cookie }, payload: body });
  return { status: res.statusCode, body: res.json() };
};
const run = (name: string, body: object = {}, cookie = ops) =>
  send(`/api/actions/${name}/run`, cookie, body);
const query = async (text: string, params: unknown[] = []) =>
  (await sqlPool.query<Record<string, unknown>>(text, params)).rows;
const auditCount = async () =>
  Number((await query('select count(*) as n from warden.audit_log'))[0]!.n);
const entries = (since: number) =>
  query('select * from warden.audit_log where id > $1 order by id', [since]);
const lastId = async () =>
  Number((await query('select coalesce(max(id), 0) as id from warden.audit_log'))[0]!.id);
const calls = (prefix: string) => received.filter((r) => r.url.startsWith(prefix));

describe('HTTP actions: listing and preview', () => {
  it('are offered as confirm-only, with nothing they write through tx', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/actions', headers: { cookie: ops } });
    const review = res.json().actions.find((a: { name: string }) => a.name === 'review-user');
    expect(review).toMatchObject({ confirm: 'confirm', permissions: {}, requireReason: true });
  });

  it('refuses to preview, without calling the API', async () => {
    const res = await send('/api/actions/review-user/preview', ops, {
      records: ['1'],
      input: { decision: 'approve' },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/can't be previewed/);
    expect(received).toHaveLength(0);
  });

  it('is a 404 to a role without the action, preview or run', async () => {
    const before = await auditCount();
    for (const path of ['preview', 'run']) {
      const res = await send(`/api/actions/review-user/${path}`, viewer, {
        records: ['1'],
        input: { decision: 'approve' },
      });
      expect(res.status).toBe(404);
    }
    expect((await run('not-granted')).status).toBe(404);
    expect(received).toHaveLength(0);
    expect(await auditCount()).toBe(before);
  });

  it('still requires a reason', async () => {
    const res = await run('review-user', {
      records: ['1'],
      input: { decision: 'approve' },
      reason: undefined,
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

describe('HTTP actions: a real run', () => {
  it('calls the endpoint once, signed, after auditing the attempt, and audits the answer', async () => {
    const since = await lastId();
    respond = () => ({ status: 200, body: { message: 'Approved <b>user1</b>', id: 77 } });
    const res = await run('review-user', { records: ['1'], input: { decision: 'approve' } });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ message: 'Approved user1' });

    expect(received).toHaveLength(1);
    const call = received[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/review/1?source=warden');
    expect(JSON.parse(call.body)).toEqual({
      decision: 'approve',
      email: expect.stringMatching(/^user1@/),
      note: REASON,
    });
    expect(call.headers['idempotency-key']).toBe(res.body.auditId);
    expect(call.headers.authorization).toBeUndefined();
    const context = verifyWardenRequest({
      secret: SECRET,
      method: call.method,
      path: call.url,
      headers: call.headers,
      rawBody: call.body,
    });
    expect(context).toEqual({
      action: 'review-user',
      auditId: res.body.auditId,
      requestId: expect.any(String),
      actor: { subject: 'editor', email: expect.any(String), roles: ['ops'] },
      reason: REASON,
      records: ['1'],
      recordCount: 1,
    });

    const [attempt, answer] = await entries(since);
    expect(attempt).toMatchObject({
      id: res.body.auditId,
      action: 'review-user',
      entity: 'users',
      record_id: '1',
      actor_subject: 'editor',
      reason: REASON,
      details: { input: { decision: 'approve' }, records: ['1'] },
    });
    expect(answer).toMatchObject({
      action: 'review-user',
      entity: 'users',
      record_id: '1',
      parent_id: null,
      details: {
        input: {},
        records: ['1'],
        outcome: {
          attempt: res.body.auditId,
          endpoint: `POST ${apiUrl}/review/1`,
          result: 'ok',
          status: 200,
          message: 'Approved user1',
          resultId: '77',
        },
      },
    });
  });

  it('shows the API outcome in History to who may run it', async () => {
    respond = () => ({ status: 200, body: { message: 'ok then' } });
    await run('review-user', { records: ['2'], input: { decision: 'approve' } });
    const history = await app.inject({
      url: '/api/entities/users/2/history',
      headers: { cookie: ops },
    });
    const items = history.json().items as { details: { outcome?: { result: string } } }[];
    expect(items.some((i) => i.details?.outcome?.result === 'ok')).toBe(true);
    const asViewer = await app.inject({
      url: '/api/entities/users/2/history',
      headers: { cookie: viewer },
    });
    expect(asViewer.json().items).toEqual([]);
  });

  it("shows a 4xx's message, cleaned and capped", async () => {
    const since = await lastId();
    respond = () => ({
      status: 422,
      body: { message: `<script>x</script>Payout <b>already</b>\nresolved ${'!'.repeat(1000)}` },
    });
    const res = await run('review-user', { records: ['1'], input: { decision: 'reject' } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^x Payout already resolved !+…$/);
    expect(res.body.message.length).toBeLessThanOrEqual(300);
    expect(res.body.message).not.toContain('<');
    const answer = (await entries(since))[1]!;
    expect(answer.details).toMatchObject({ outcome: { result: 'rejected', status: 422 } });
  });

  it('says "not allowed" for a 401 or 403 without a usable message', async () => {
    respond = () => ({
      status: 403,
      body: '<html>Forbidden page</html>',
      contentType: 'text/html',
    });
    const res = await run('review-user', { records: ['1'], input: { decision: 'reject' } });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not allowed/);
    expect(res.body.message).not.toContain('Forbidden page');
  });

  it('gives a generic error for a 5xx, and logs it', async () => {
    const since = await lastId();
    respond = () => ({ status: 500, body: { message: 'database password is hunter2' } });
    const res = await run('review-user', { records: ['1'], input: { decision: 'approve' } });
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('the API this action calls failed; try again later');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(
      logLines.some((l) => l.includes('action API failed') && l.includes('"status":500')),
    ).toBe(true);
    const answer = (await entries(since))[1]!;
    expect(answer.details).toMatchObject({ outcome: { result: 'failed', status: 500 } });
    expect(JSON.stringify(answer.details)).not.toContain('hunter2');
  });

  it('gives a generic error when the API is too slow', async () => {
    respond = () => ({ status: 200, delayMs: 1500 });
    const res = await run('review-user', { records: ['1'], input: { decision: 'approve' } });
    expect(res.status).toBe(504);
    expect(res.body.message).toBe('the API this action calls did not answer in time');
    expect(logLines.some((l) => l.includes('action API timed out'))).toBe(true);
  });

  it("doesn't follow redirects", async () => {
    respond = (req) =>
      req.url.startsWith('/review')
        ? { status: 307, headers: { location: `${apiUrl}/elsewhere` } }
        : { status: 200 };
    const res = await run('review-user', { records: ['1'], input: { decision: 'approve' } });
    expect(res.status).toBe(502);
    expect(calls('/elsewhere')).toHaveLength(0);
  });

  it('refuses a non-https URL before writing anything or calling out', async () => {
    const before = await auditCount();
    const res = await run('off-site');
    expect(res.status).toBe(500);
    expect(await auditCount()).toBe(before);
    expect(logLines.some((l) => l.includes('must use https'))).toBe(true);
  });
});

describe('HTTP actions on many records', () => {
  it('reports per-record failures with perRecord', async () => {
    const since = await lastId();
    respond = (req) =>
      req.url === '/each/2'
        ? { status: 409, body: { message: 'locked' } }
        : req.url === '/each/3'
          ? { status: 503, body: { message: 'internal detail' } }
          : { status: 200, body: {} };
    const res = await run('review-many', { records: ['1', '2', '3'] });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      message: 'Done for 1 of 3 records.',
      records: [
        { id: '1', ok: true },
        { id: '2', ok: false, message: 'locked' },
        { id: '3', ok: false, message: 'the API this action calls failed; try again later' },
      ],
    });
    expect(received).toHaveLength(3);
    const keys = received.map((r) => r.headers['idempotency-key']).sort();
    expect(keys).toEqual([1, 2, 3].map((i) => `${res.body.auditId}.${i}`));
    for (const call of received) {
      const context = verifyWardenRequest({
        secret: SECRET,
        method: call.method,
        path: call.url,
        headers: call.headers,
        rawBody: call.body,
      });
      expect(context.records).toEqual([call.url.split('/').at(-1)]);
      expect(JSON.parse(call.body)).toEqual({ input: {}, records: context.records });
    }
    const answer = (await entries(since))[1]!;
    expect(answer.details).toMatchObject({
      outcome: {
        result: 'partial',
        records: [
          { id: '1', result: 'ok', status: 200 },
          { id: '2', result: 'rejected', status: 409, message: 'locked' },
          { id: '3', result: 'failed', status: 503 },
        ],
      },
    });
  });

  it("sends one request for all records and passes on the API's per-record results", async () => {
    respond = () => ({
      status: 200,
      body: {
        message: 'Reviewed',
        records: [
          { id: '1', ok: true },
          { id: 2, ok: false, message: '<i>blocked</i>' },
          { id: '999', ok: false, message: 'not ours' },
        ],
      },
    });
    const res = await run('review-batch', { records: ['1', '2'] });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      message: 'Reviewed',
      records: [
        { id: '1', ok: true },
        { id: '2', ok: false, message: 'blocked' },
      ],
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe('PUT');
    expect(JSON.parse(received[0]!.body)).toEqual({ input: {}, records: ['1', '2'] });
  });

  it("audits a batch the API partly or wholly rejected as 'partial' or 'rejected'", async () => {
    const since = await lastId();
    respond = () => ({
      status: 200,
      body: {
        records: [
          { id: '1', ok: true },
          { id: '2', ok: false, message: 'held' },
        ],
      },
    });
    expect((await run('review-batch', { records: ['1', '2'] })).status).toBe(200);
    respond = () => ({
      status: 200,
      body: {
        records: [
          { id: '1', ok: false },
          { id: '2', ok: false, message: 'held' },
        ],
      },
    });
    expect((await run('review-batch', { records: ['1', '2'] })).status).toBe(200);
    const answers = (await entries(since)).filter(
      (e) => e.details && 'outcome' in (e.details as object),
    );
    expect(
      answers.map((e) => (e.details as { outcome: { result: string } }).outcome.result),
    ).toEqual(['partial', 'rejected']);
  });

  it('starts no request after the deadline, and says which records were skipped', async () => {
    const since = await lastId();
    respond = () => ({ status: 200, body: {}, delayMs: 600 });
    const res = await run('review-slow', { records: ['1', '2', '3'] });
    expect(res.status).toBe(200);
    expect(calls('/slow/3')).toHaveLength(0);
    const records = res.body.result.records as { id: string; ok: boolean; message?: string }[];
    expect(records[0]).toEqual({ id: '1', ok: true });
    expect(records[2]).toEqual({
      id: '3',
      ok: false,
      message: 'not attempted: the action ran out of time',
    });
    const answer = (await entries(since))[1]!;
    expect(answer.details).toMatchObject({
      outcome: {
        records: expect.arrayContaining([
          { id: '3', result: 'failed', message: 'not attempted: the action ran out of time' },
        ]),
      },
    });
  });

  it('keeps X-Warden-Context small however many records there are', async () => {
    const ids = Array.from({ length: 500 }, () => crypto.randomUUID());
    const action: HttpAction = {
      spec: {
        method: 'PUT',
        auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' },
        timeoutMs: 1000,
        perRecord: false,
        concurrency: 1,
      },
      authenticator: { retryOn401: false, credentials: async () => ({ secret: SECRET }) },
    };
    const body = JSON.stringify({ input: {}, records: ids });
    const called = await runHttpAction({
      req: {} as never,
      action,
      method: 'PUT',
      plans: [{ url: `${apiUrl}/batch`, body, records: ids }],
      credentials: { secret: SECRET },
      auditId: '1',
      deadlineMs: 10_000,
      context: {
        action: 'review-batch',
        auditId: '1',
        requestId: 'r',
        actor: { subject: 'editor', email: 'editor@example.com', roles: ['ops'] },
        reason: 'x'.repeat(2000),
      },
      log: app.log,
    });
    expect(called.outcome.result).toBe('ok');
    const call = received[0]!;
    expect(String(call.headers['x-warden-context']).length).toBeLessThan(8192);
    const context = verifyWardenRequest({
      secret: SECRET,
      method: call.method,
      path: call.url,
      headers: call.headers,
      rawBody: call.body,
    });
    expect(context.recordCount).toBe(500);
    expect(context.records.length).toBeGreaterThan(0);
    expect(context.records.length).toBeLessThan(500);
    expect(context.records).toEqual(ids.slice(0, context.records.length));
    expect(JSON.stringify(context.records).length).toBeLessThanOrEqual(MAX_CONTEXT_RECORD_BYTES);
  });
});

describe('HTTP action auth', () => {
  it('client_credentials: caches the token, and renews it once on a 401', async () => {
    let issued = 0;
    let rejectNext = false;
    respond = (req) => {
      if (req.url === '/oauth/token') {
        issued++;
        return { status: 200, body: { access_token: `${M2M_TOKEN}-${issued}`, expires_in: 3600 } };
      }
      if (rejectNext) {
        rejectNext = false;
        return { status: 401, body: { message: 'expired' } };
      }
      return { status: 200, body: { message: 'pong' } };
    };
    expect((await run('m2m-ping')).status).toBe(200);
    expect((await run('m2m-ping')).status).toBe(200);
    expect(calls('/oauth/token')).toHaveLength(1);
    const form = new URLSearchParams(calls('/oauth/token')[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'warden-m2m',
      client_secret: CLIENT_SECRET,
      audience: 'https://api.test',
    });
    expect(calls('/m2m').map((c) => c.headers.authorization)).toEqual([
      `Bearer ${M2M_TOKEN}-1`,
      `Bearer ${M2M_TOKEN}-1`,
    ]);
    // The bearer token says only that it's Warden; the signature vouches for the actor.
    const signed = calls('/m2m')[0]!;
    expect(
      verifyWardenRequest({
        secret: SECRET,
        method: signed.method,
        path: signed.url,
        headers: signed.headers,
        rawBody: signed.body,
      }).actor.subject,
    ).toBe('editor');

    rejectNext = true;
    const res = await run('m2m-ping');
    expect(res.status).toBe(200);
    expect(calls('/oauth/token')).toHaveLength(2);
    expect(
      calls('/m2m')
        .slice(-2)
        .map((c) => c.headers.authorization),
    ).toEqual([`Bearer ${M2M_TOKEN}-1`, `Bearer ${M2M_TOKEN}-2`]);
  });

  it("user: sends the signed-in user's token for the audience", async () => {
    const res = await run('as-user');
    expect(res.status).toBe(200);
    expect(calls('/as-user')[0]!.headers.authorization).toBe('Bearer user-token-editor');
  });

  it('user: asks to sign in again, without calling the API, when there is no token', async () => {
    const before = await auditCount();
    const res = await run('as-user', {}, admin);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Sign in again to continue');
    expect(received).toHaveLength(0);
    expect(await auditCount()).toBe(before);
  });

  it('never logs or audits secrets and tokens', async () => {
    const audit = JSON.stringify(await query('select * from warden.audit_log'));
    for (const secret of [SECRET, CLIENT_SECRET, M2M_TOKEN, 'user-token-']) {
      expect(logLines.join('\n')).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
  });
});

describe('HTTP actions at startup', () => {
  const moduleWith = (source: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'warden-http-')), 'actions.js');
    writeFileSync(file, source);
    return file;
  };
  const action = (http: string) =>
    moduleWith(`export default ({ defineAction }) => [
      defineAction({ name: 'hook', label: 'Hook', on: 'companies', target: 'none', http: ${http} }),
    ];`);
  const start = (env: Record<string, string>, tokens?: UserTokenProvider) =>
    createWarden({
      env: { ...baseEnv(), WARDEN_CONFIG: writeConfig(CONFIG), ...env },
      ...(tokens ? { userTokens: tokens } : {}),
    });

  it('fails when a secret variable is not set', async () => {
    const err = await start({ TEST_HMAC_SECRET: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsError);
    expect((err as ActionsError).problems).toContain(
      'action "review-user": environment variable TEST_HMAC_SECRET is not set',
    );
  });

  it('fails when client_credentials has no signing secret', async () => {
    const file = action(`{
      url: 'https://api.example.com/x',
      auth: {
        type: 'client_credentials',
        tokenUrl: 'https://idp.example.com/token',
        clientIdEnv: 'TEST_CLIENT_ID',
        clientSecretEnv: 'TEST_CLIENT_SECRET',
      },
    }`);
    const err = await start({ WARDEN_ACTIONS: file }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsError);
    expect((err as ActionsError).problems).toContain(
      'action "hook": http.auth.secretEnv must be an environment variable name',
    );
  });

  it("doesn't hold the action pool's slot while calling the API", async () => {
    const small = await start(
      { WARDEN_ACTION_MAX_CONCURRENT: '1', WARDEN_ACTION_MAX_PER_USER: '2' },
      userTokens,
    );
    try {
      const editor = await login(small, 'editor');
      // Record 1 takes a while; review-batch waits up to its default 10 s timeout.
      respond = (req) =>
        req.body.includes('["1"]') ? { status: 200, body: {}, delayMs: 2000 } : { status: 200 };
      const runOn = (id: string) =>
        small.inject({
          method: 'POST',
          url: '/api/actions/review-batch/run',
          headers: { cookie: editor },
          payload: { reason: REASON, records: [id] },
        });
      const slow = runOn('1');
      // Once the first run is calling the API, its transaction has committed.
      while (calls('/batch').length === 0) await new Promise((r) => setTimeout(r, 10));
      // The only pool slot is free again...
      expect((await runOn('2')).statusCode).toBe(200);
      // ...but the user's API calls still count against their own limit.
      const [third, fourth] = [runOn('1'), runOn('3')];
      expect([(await third).statusCode, (await fourth).statusCode]).toContain(429);
      expect((await slow).statusCode).toBe(200);
    } finally {
      await small.close();
    }
  });

  it('fails when user auth has no token provider, or the audience is not requested', async () => {
    const err = await start({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsError);
    expect((err as ActionsError).problems.join('\n')).toMatch(
      /action "as-user": http.auth type "user" needs OIDC_AUDIENCE set to "https:\/\/api.test"/,
    );
    const other = await start({}, { ...userTokens, audience: 'https://other.test' }).catch(
      (e: unknown) => e,
    );
    expect((other as ActionsError).problems).toContain(
      'action "as-user": http.auth.audience "https://api.test" is not the audience login requests',
    );
  });

  it("user: without a provider passed in, sends the access token the user's session keeps", async () => {
    const app = await start({ OIDC_AUDIENCE: 'https://api.test' });
    try {
      const editor = await login(app, 'editor');
      const res = await app.inject({
        method: 'POST',
        url: '/api/actions/as-user/run',
        headers: { cookie: editor },
        payload: { reason: REASON },
      });
      expect(res.statusCode, res.body).toBe(200);
      const sent = calls('/as-user').at(-1)!.headers.authorization;
      expect(sent).toMatch(/^Bearer \S+$/);
      expect(sent).not.toContain('user-token-');
    } finally {
      await app.close();
    }
  });

  it('refuses a fixed http URL off loopback unless WARDEN_ACTION_ALLOW_HTTP is on', async () => {
    const file = action(
      `{ url: 'http://api.example.com/x', auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' } }`,
    );
    const err = await start({ WARDEN_ACTIONS: file }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsError);
    expect((err as ActionsError).problems[0]).toMatch(/http.url must use https/);
    const allowed = await start({ WARDEN_ACTIONS: file, WARDEN_ACTION_ALLOW_HTTP: 'true' });
    await allowed.close();
  });

  it('refuses run and http together, and a preview confirm', async () => {
    const file = moduleWith(`export default ({ defineAction }) => [
      defineAction({
        name: 'both', label: 'Both', on: 'companies', target: 'none', confirm: 'preview',
        run: async () => {},
        http: { url: 'https://api.example.com', auth: { type: 'hmac', secretEnv: 'X' } },
      }),
    ];`);
    const err = await start({ WARDEN_ACTIONS: file }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsError);
    expect((err as ActionsError).problems).toEqual(
      expect.arrayContaining([
        'action "both": give either run or http, not both',
        'action "both": http actions can\'t be previewed; leave confirm out',
      ]),
    );
  });
});
