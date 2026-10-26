import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWardenRequest } from '../../../docs/examples/verify-warden-request.mjs';
import { ActionsError } from '../src/actions.js';
import type { UserTokenProvider } from '../src/http-actions.js';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp, writeConfig } from './helpers/auth.js';
import type { MockOidc } from '@wardenhq/mock-oidc';

const ACTIONS = fileURLToPath(new URL('./fixtures/http-steps.js', import.meta.url));
const SECRET = 'test-hmac-secret-steps-0123';
const REASON = 'resolving the review';

const STEP_ACTIONS = [
  'resolve-review',
  'three-with-undo',
  'needs-body',
  'slow-steps',
  'steps-as-user',
  'refuses-later',
  'secret-input',
  'uses-redacted',
  'reads-unredacted',
  'm2m-steps',
  'pinned-steps',
];
const CONFIG = `
defaults: { read: granted }
roles:
  viewer: { grants: { '*': [read] } }
  ops:
    grants: { users: [read], companies: [read] }
    actions: [${STEP_ACTIONS.join(', ')}]
  admin:
    grants: { '*': [read] }
    admin: [audit]
    actions: [${STEP_ACTIONS.join(', ')}]
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
  delayMs?: number;
}
interface StepView {
  name: string;
  result: string;
  message?: string;
  compensation?: { result: string; message?: string };
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

const userTokens: UserTokenProvider = {
  audience: 'https://api.test',
  accessTokenFor: async (req) => `user-token-${req.session?.subject}`,
};

const baseEnv = () => ({
  DATABASE_URL: db.connectionString,
  WARDEN_CONFIG: writeConfig(CONFIG),
  WARDEN_ACTIONS: ACTIONS,
  TEST_HMAC_SECRET: SECRET,
  TEST_CLIENT_ID: 'warden-steps',
  TEST_CLIENT_SECRET: 'm2m-steps-secret',
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
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? {}));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  (globalThis as { __wardenStepsApi?: string }).__wardenStepsApi = apiUrl;

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
  app = await createWarden({ env: baseEnv(), userTokens, logger: { level: 'info', stream } });
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

const post = async (url: string, cookie: string, payload: object) => {
  const res = await app.inject({ method: 'POST', url, headers: { cookie }, payload });
  return { status: res.statusCode, body: res.json() };
};
const run = (name: string, body: object = {}, cookie = ops) =>
  post(`/api/actions/${name}/run`, cookie, 'reason' in body ? body : { ...body, reason: REASON });
const retry = (name: string, auditId: string, cookie = ops) =>
  post(`/api/actions/${name}/retry`, cookie, { auditId });
const query = async (text: string, params: unknown[] = []) =>
  (await sqlPool.query<Record<string, unknown>>(text, params)).rows;
const lastId = async () =>
  Number((await query('select coalesce(max(id), 0) as id from warden.audit_log'))[0]!.id);
const entries = (since: number) =>
  query('select * from warden.audit_log where id > $1 order by id', [since]);
const paths = () => received.map((r) => `${r.method} ${r.url}`);
const results = (steps: StepView[]) => steps.map((s) => `${s.name}:${s.result}`);
const keys = () => received.map((r) => r.headers['idempotency-key']);
/** The random key attempt `auditId` stored, which starts its steps' keys. */
const attemptKey = async (auditId: string) =>
  String(
    (
      await query(`select details -> 'http' ->> 'key' as key from warden.audit_log where id = $1`, [
        auditId,
      ])
    )[0]!.key,
  );

describe('multi-step HTTP actions: a run', () => {
  it('calls the steps in order, each with its own key, and hands earlier answers on', async () => {
    const since = await lastId();
    respond = (req) =>
      req.url.startsWith('/payouts')
        ? { status: 200, body: { claimId: 'c-9', id: 'p-1', secret: 'hide me', message: 'Paid' } }
        : req.url.startsWith('/claims')
          ? { status: 201, body: { message: 'Claim resolved' } }
          : { status: 200, body: {} };
    const res = await run('resolve-review', { records: ['1'], input: { decision: 'fraudulent' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const auditId = res.body.auditId as string;
    expect(res.body.result).toEqual({
      message: 'Claim resolved',
      steps: [
        { name: 'payout', result: 'ok', message: 'Paid' },
        { name: 'claim', result: 'ok', message: 'Claim resolved' },
        { name: 'notify', result: 'ok' },
      ],
    });
    expect(paths()).toEqual(['POST /payouts/1/review', 'POST /claims/c-9/resolve', 'PUT /notify']);
    const key = await attemptKey(auditId);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys()).toEqual([`${key}.payout`, `${key}.claim`, `${key}.notify`]);
    expect(JSON.parse(received[0]!.body)).toEqual({ decision: 'fraudulent', note: REASON });
    expect(JSON.parse(received[1]!.body)).toEqual({ decision: 'fraudulent', payoutStatus: 200 });
    expect(JSON.parse(received[2]!.body)).toEqual({ claimed: true });
    // Every step is signed and names the actor, as a single call is.
    for (const call of received) {
      const context = verifyWardenRequest({
        secret: SECRET,
        host: new URL(apiUrl).host,
        method: call.method,
        path: call.url,
        headers: call.headers,
        rawBody: call.body,
      });
      expect(context).toMatchObject({
        action: 'resolve-review',
        auditId,
        actor: { subject: 'editor', roles: ['ops'] },
        reason: REASON,
        records: ['1'],
      });
    }

    const [attempt, answer] = await entries(since);
    expect(attempt).toMatchObject({
      id: auditId,
      action: 'resolve-review',
      reason: REASON,
      details: { http: { key, steps: ['payout', 'claim', 'notify'] } },
    });
    const outcome = (answer!.details as { outcome: Record<string, unknown> }).outcome;
    expect(outcome).toMatchObject({
      attempt: auditId,
      result: 'ok',
      steps: [
        {
          name: 'payout',
          result: 'ok',
          endpoint: `POST ${apiUrl}/payouts/1/review`,
          status: 200,
          resultId: 'p-1',
          durationMs: expect.any(Number),
          // Kept because the step opts in, with `secret` redacted.
          body: { claimId: 'c-9', id: 'p-1', secret: '[redacted]', message: 'Paid' },
        },
        { name: 'claim', result: 'ok', status: 201, durationMs: expect.any(Number) },
        { name: 'notify', result: 'ok', status: 200 },
      ],
    });
    const steps = outcome.steps as Record<string, unknown>[];
    expect(steps[1]).not.toHaveProperty('body');
    expect(steps[2]).not.toHaveProperty('body');
    expect(JSON.stringify(answer)).not.toContain('hide me');
  });

  it('records a step its `when` skips as skipped, and later steps see it absent', async () => {
    const since = await lastId();
    respond = () => ({ status: 200, body: { claimId: 'c-1' } });
    const res = await run('resolve-review', {
      records: ['1'],
      input: { decision: 'not_fraudulent' },
    });
    expect(res.status).toBe(200);
    expect(results(res.body.result.steps)).toEqual(['payout:ok', 'claim:skipped', 'notify:ok']);
    expect(paths()).toEqual(['POST /payouts/1/review', 'PUT /notify']);
    expect(JSON.parse(received[1]!.body)).toEqual({ claimed: false });
    const answer = (await entries(since))[1]!;
    expect(answer.details).toMatchObject({
      outcome: { result: 'ok', steps: [{ result: 'ok' }, { result: 'skipped' }, { result: 'ok' }] },
    });
  });

  it('stops at the first failure: later steps are never called', async () => {
    const since = await lastId();
    respond = (req) =>
      req.url.startsWith('/payouts')
        ? { status: 422, body: { message: 'Payout already resolved' } }
        : { status: 200, body: {} };
    const res = await run('resolve-review', { records: ['1'], input: { decision: 'fraudulent' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: 'Payout already resolved',
      auditId: expect.any(String),
      retryable: true,
    });
    expect(results(res.body.steps)).toEqual([
      'payout:rejected',
      'claim:not_attempted',
      'notify:not_attempted',
    ]);
    expect(paths()).toEqual(['POST /payouts/1/review']);
    const answer = (await entries(since))[1]!;
    expect(answer.details).toMatchObject({
      outcome: {
        result: 'rejected',
        status: 422,
        steps: [
          { name: 'payout', result: 'rejected', status: 422, message: 'Payout already resolved' },
          { name: 'claim', result: 'not_attempted' },
          { name: 'notify', result: 'not_attempted' },
        ],
      },
    });
  });

  it('a 5xx in a later step is a generic 502 and a partial outcome', async () => {
    const since = await lastId();
    respond = (req) =>
      req.url.startsWith('/claims')
        ? { status: 500, body: { message: 'db password is hunter2' } }
        : { status: 200, body: { claimId: 'c-2' } };
    const res = await run('resolve-review', { records: ['1'], input: { decision: 'fraudulent' } });
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('the API this action calls failed; try again later');
    expect(results(res.body.steps)).toEqual(['payout:ok', 'claim:failed', 'notify:not_attempted']);
    expect(calls('/notify')).toHaveLength(0);
    const answer = (await entries(since))[1]!;
    expect(answer.details).toMatchObject({ outcome: { result: 'partial', status: 500 } });
    expect(JSON.stringify(answer.details)).not.toContain('hunter2');
  });

  it("an ActionError from a later step's url stops the chain with its message", async () => {
    respond = () => ({ status: 200, body: { locked: true } });
    const res = await run('refuses-later');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('The payout is locked');
    expect(results(res.body.steps)).toEqual(['a:ok', 'b:rejected']);
    expect(paths()).toEqual(['POST /refuse/a']);
  });

  it('sends every step with the user auth mode', async () => {
    const res = await run('steps-as-user');
    expect(res.status).toBe(200);
    expect(received.map((r) => r.headers.authorization)).toEqual([
      'Bearer user-token-editor',
      'Bearer user-token-editor',
    ]);
  });
});

const calls = (prefix: string) => received.filter((r) => r.url.startsWith(prefix));

describe('multi-step HTTP actions: compensate', () => {
  it('undoes completed steps in reverse order, and reports an undo that failed', async () => {
    const since = await lastId();
    respond = (req) => {
      if (req.url === '/second') return { status: 200, body: { id: 's-7' } };
      if (req.url === '/third') return { status: 503, body: {} };
      if (req.url.startsWith('/second/undo')) return { status: 500, body: { message: 'nope' } };
      return { status: 200, body: {} };
    };
    const res = await run('three-with-undo');
    expect(res.status).toBe(502);
    const auditId = res.body.auditId as string;
    expect(paths()).toEqual([
      'POST /first',
      'POST /second',
      'POST /third',
      'POST /second/undo/s-7',
      'DELETE /first/undo',
    ]);
    const key = await attemptKey(auditId);
    expect(keys().slice(3)).toEqual([`${key}.second.compensate`, `${key}.first.compensate`]);
    expect(JSON.parse(received[3]!.body)).toEqual({ undo: true });
    expect(res.body.steps).toEqual([
      { name: 'first', result: 'ok', compensation: { result: 'ok' } },
      {
        name: 'second',
        result: 'ok',
        compensation: { result: 'failed', message: 'undoing this step failed' },
      },
      {
        name: 'third',
        result: 'failed',
        message: 'the API this action calls failed; try again later',
      },
    ]);
    // Steps were undone (or tried to be), so retrying the rest isn't offered.
    expect(res.body.retryable).toBe(false);
    expect(logLines.some((l) => l.includes('undo call failed') && l.includes('"second"'))).toBe(
      true,
    );
    const answer = (await entries(since))[1]!;
    expect(answer.details).toMatchObject({
      outcome: {
        result: 'partial',
        steps: [
          { name: 'first', compensation: { result: 'ok', status: 200 } },
          { name: 'second', compensation: { result: 'failed', status: 500 } },
          { name: 'third', result: 'failed', status: 503 },
        ],
      },
    });
    const retried = await retry('three-with-undo', auditId);
    expect(retried.status).toBe(409);
    expect(retried.body.message).toMatch(/undone/);
  });

  it('makes no undo call when the first step fails', async () => {
    respond = (req) => (req.url === '/first' ? { status: 500 } : { status: 200, body: {} });
    const res = await run('three-with-undo');
    expect(res.status).toBe(502);
    expect(paths()).toEqual(['POST /first']);
    expect(res.body.retryable).toBe(true);
  });
});

describe('multi-step HTTP actions: retry remaining steps', () => {
  it('resends the failed step and the rest with the same keys, never the completed ones', async () => {
    let claimFails = true;
    respond = (req) => {
      if (req.url.startsWith('/payouts')) return { status: 200, body: { claimId: 'c-5' } };
      if (req.url.startsWith('/claims') && claimFails) return { status: 504, body: {} };
      return { status: 200, body: {} };
    };
    const first = await run('resolve-review', {
      records: ['2'],
      input: { decision: 'fraudulent' },
    });
    expect(first.status).toBe(502);
    expect(first.body.retryable).toBe(true);
    const auditId = first.body.auditId as string;
    const firstKeys = keys();
    received.splice(0);

    // Not someone else's run, and not for a role without the action.
    expect((await retry('resolve-review', auditId, admin)).status).toBe(404);
    expect((await retry('resolve-review', auditId, viewer)).status).toBe(404);
    expect(received).toHaveLength(0);

    const since = await lastId();
    claimFails = false;
    const res = await retry('resolve-review', auditId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.auditId).toBe(auditId);
    expect(paths()).toEqual(['POST /claims/c-5/resolve', 'PUT /notify']);
    const key = await attemptKey(auditId);
    expect(keys()).toEqual([firstKeys[1], `${key}.notify`]);
    expect(keys()[0]).toBe(`${key}.claim`);
    // The same request as the first try: rebuilt from the attempt's entry.
    expect(JSON.parse(received[0]!.body)).toEqual({ decision: 'fraudulent', payoutStatus: 200 });
    expect(results(res.body.result.steps)).toEqual(['payout:ok', 'claim:ok', 'notify:ok']);

    // Append-only: the retry's own entry, then its outcome. The attempt is untouched.
    const [retryEntry, answer] = await entries(since);
    expect(retryEntry).toMatchObject({
      action: 'resolve-review',
      record_id: '2',
      reason: REASON,
      actor_subject: 'editor',
      details: { input: {}, records: ['2'], retryOf: auditId },
    });
    expect(answer!.details).toMatchObject({
      outcome: {
        attempt: auditId,
        retry: retryEntry!.id,
        result: 'ok',
        steps: [
          { name: 'payout', result: 'ok', earlier: true },
          { name: 'claim', result: 'ok', status: 200 },
          { name: 'notify', result: 'ok' },
        ],
      },
    });
    const [attempt] = await query('select details from warden.audit_log where id = $1', [auditId]);
    expect(attempt!.details).not.toHaveProperty('outcome');

    received.splice(0);
    const again = await retry('resolve-review', auditId);
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already completed/);
    expect(received).toHaveLength(0);
  });

  it("refuses to retry when a later step needs an earlier body that wasn't kept", async () => {
    let useFails = true;
    respond = (req) =>
      req.url === '/make'
        ? { status: 200, body: { id: 'm-1' } }
        : useFails
          ? { status: 503 }
          : { status: 200, body: {} };
    const first = await run('needs-body');
    expect(first.status).toBe(502);
    expect(paths()).toEqual(['POST /make', 'POST /use/m-1']);
    received.splice(0);
    useFails = false;
    const res = await retry('needs-body', first.body.auditId);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/wasn't kept/);
    expect(results(res.body.steps)).toEqual(['make:ok', 'use:failed']);
    expect(received).toHaveLength(0);
  });

  it('is refused for an action with sensitive input, an unknown run, or a malformed id', async () => {
    respond = (req) => (req.url === '/secret/b' ? { status: 500 } : { status: 200, body: {} });
    const first = await run('secret-input', { input: { token: 't0ps3cret' } });
    expect(first.status).toBe(502);
    expect(first.body.retryable).toBe(false);
    expect((await retry('secret-input', first.body.auditId)).status).toBe(409);
    expect((await retry('resolve-review', first.body.auditId)).status).toBe(404);
    expect((await retry('resolve-review', '999999999')).status).toBe(404);
    expect((await retry('resolve-review', '1 or 1=1')).status).toBe(400);
    expect((await retry('steps-not-granted', first.body.auditId)).status).toBe(404);
  });
});

/** A copy of entry `id` written `ago` earlier, with `details` merged into its details. */
const copyEntry = async (id: string, details: object, ago = '0 seconds') =>
  String(
    (
      await query(
        `insert into warden.audit_log (occurred_at, request_id, actor_subject, actor_email,
           actor_roles, action, entity, record_id, primary_key, reason, details)
         select now() - $3::interval, request_id, actor_subject, actor_email, actor_roles, action,
           entity, record_id, primary_key, reason, details || $2::jsonb
         from warden.audit_log where id = $1 returning id`,
        [id, JSON.stringify(details), ago],
      )
    )[0]!.id,
  );

/** A copy of attempt `from`'s outcome entries, as outcomes of attempt `to`. */
const copyOutcome = (from: string, to: string) =>
  query(
    `insert into warden.audit_log (occurred_at, request_id, actor_subject, actor_email,
       actor_roles, action, entity, record_id, primary_key, reason, details)
     select now(), request_id, actor_subject, actor_email, actor_roles, action, entity, record_id,
       primary_key, reason, jsonb_set(details, '{outcome,attempt}', to_jsonb($2::text))
     from warden.audit_log where details -> 'outcome' ->> 'attempt' = $1`,
    [from, to],
  );

describe('multi-step HTTP actions: retry failure paths', () => {
  /** A resolve-review run whose `claim` step failed, and so can be retried. */
  const failedRun = async () => {
    respond = (req) =>
      req.url.startsWith('/payouts')
        ? { status: 200, body: { claimId: 'c-7' } }
        : req.url.startsWith('/claims')
          ? { status: 502 }
          : { status: 200, body: {} };
    const res = await run('resolve-review', { records: ['1'], input: { decision: 'fraudulent' } });
    expect(res.status).toBe(502);
    expect(res.body.retryable).toBe(true);
    received.splice(0);
    respond = (req) =>
      req.url.startsWith('/claims')
        ? { status: 200, body: {}, delayMs: 300 }
        : { status: 200, body: {} };
    return res.body.auditId as string;
  };

  it("refuses a retry that reads a redacted value, and sends nothing in the value's place", async () => {
    let useFails = true;
    respond = (req) =>
      req.url === '/redact/hold'
        ? { status: 200, body: { id: 'h-1', token: 'tok-secret' } }
        : useFails
          ? { status: 503 }
          : { status: 200, body: {} };
    const first = await run('uses-redacted');
    expect(first.status).toBe(502);
    expect(JSON.parse(calls('/redact/use')[0]!.body)).toEqual({ token: 'tok-secret' });
    received.splice(0);
    useFails = false;
    const res = await retry('uses-redacted', first.body.auditId);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/wasn't kept/);
    expect(results(res.body.steps)).toEqual(['hold:ok', 'use:failed']);
    expect(received).toHaveLength(0);
  });

  it('retries a step that reads only values its earlier step kept', async () => {
    let useFails = true;
    respond = (req) =>
      req.url === '/unredacted/hold'
        ? { status: 200, body: { id: 'h-2', token: 'tok-secret', nested: { a: [1, 2] } } }
        : useFails
          ? { status: 503 }
          : { status: 200, body: {} };
    const first = await run('reads-unredacted');
    expect(first.status).toBe(502);
    received.splice(0);
    useFails = false;
    const res = await retry('reads-unredacted', first.body.auditId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(paths()).toEqual(['POST /unredacted/use/h-2']);
    expect(JSON.parse(received[0]!.body)).toEqual({ nested: { a: [1, 2] } });
  });

  it('refuses a retry while the run is still calling the API', async () => {
    respond = (req) => ({
      status: 200,
      body: { claimId: 'c-8' },
      delayMs: req.url.startsWith('/payouts') ? 400 : 0,
    });
    const since = await lastId();
    const running = run('resolve-review', { records: ['1'], input: { decision: 'fraudulent' } });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const [attempt] = await entries(since);
    const res = await retry('resolve-review', String(attempt!.id));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/still calling the API/);
    expect((await running).status).toBe(200);
    expect(calls('/payouts')).toHaveLength(1);
  });

  it('refuses a retry of a run whose outcome was never recorded', async () => {
    const auditId = await failedRun();
    // As if the server stopped after the steps, before writing the outcome entry.
    const lost = await copyEntry(auditId, {});
    const res = await retry('resolve-review', lost);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/wasn't recorded/);
    expect(received).toHaveLength(0);
  });

  it('refuses a retry after an earlier retry whose outcome was never recorded', async () => {
    const auditId = await failedRun();
    await copyEntry(auditId, { input: {}, refs: {}, retryOf: auditId });
    const res = await retry('resolve-review', auditId);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/wasn't recorded/);
    expect(received).toHaveLength(0);
  });

  it('lets one of two concurrent retries through, and sends each step once', async () => {
    const auditId = await failedRun();
    const both = await Promise.all([
      retry('resolve-review', auditId),
      retry('resolve-review', auditId),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(paths()).toEqual(['POST /claims/c-7/resolve', 'PUT /notify']);
  });

  it('retries again after a retry that failed', async () => {
    const auditId = await failedRun();
    respond = (req) => (req.url === '/notify' ? { status: 503 } : { status: 200, body: {} });
    const second = await retry('resolve-review', auditId);
    expect(second.status).toBe(502);
    expect(results(second.body.steps)).toEqual(['payout:ok', 'claim:ok', 'notify:failed']);
    received.splice(0);
    respond = () => ({ status: 200, body: {} });
    const third = await retry('resolve-review', auditId);
    expect(third.status, JSON.stringify(third.body)).toBe(200);
    expect(paths()).toEqual(['PUT /notify']);
    expect(keys()).toEqual([`${await attemptKey(auditId)}.notify`]);
    const done = await retry('resolve-review', auditId);
    expect(done.status).toBe(409);
    expect(done.body.message).toMatch(/already completed/);
  });

  it('refuses a retry when the steps were renamed or reordered since the run', async () => {
    const auditId = await failedRun();
    const [attempt] = await query('select details from warden.audit_log where id = $1', [auditId]);
    const { key } = (attempt!.details as { http: { key: string } }).http;
    for (const steps of [
      ['payout', 'claimV2', 'notify'],
      ['payout', 'notify', 'claim'],
      ['payout', 'claim'],
      null,
    ]) {
      // As the attempt would be had the definition differed when it ran.
      const changed = await copyEntry(auditId, { http: steps ? { key, steps } : { key } });
      await copyOutcome(auditId, changed);
      const res = await retry('resolve-review', changed);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/steps changed/);
    }
    expect(received).toHaveLength(0);
  });

  it('refuses a retry of a run whose idempotency key is missing or malformed', async () => {
    const auditId = await failedRun();
    const steps = ['payout', 'claim', 'notify'];
    for (const http of [{ steps }, { key: '1042', steps }, { key: 7, steps }]) {
      const changed = await copyEntry(auditId, { http });
      await copyOutcome(auditId, changed);
      const res = await retry('resolve-review', changed);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/idempotency key/);
    }
    expect(received).toHaveLength(0);
  });

  it('refuses a retry of a run more than 24 hours old', async () => {
    const auditId = await failedRun();
    const old = await copyEntry(auditId, {}, '25 hours');
    const res = await retry('resolve-review', old);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/too old/);
    expect(received).toHaveLength(0);
  });
});

describe('multi-step HTTP actions: http.origins', () => {
  it('builds no step or undo call for an origin outside http.origins, and sends nothing there', async () => {
    const port = Number(new URL(apiUrl).port);
    const res = await run('pinned-steps', { input: { to: `http://localhost:${port}/pinned/b` } });
    expect(res.status).toBe(500);
    expect(results(res.body.steps)).toEqual(['a:ok', 'b:failed']);
    expect(res.body.steps[0].compensation).toEqual({
      result: 'failed',
      message: 'undoing this step failed',
    });
    expect(paths()).toEqual(['POST /pinned/a']);
    expect(logLines.some((l) => l.includes('which is not in http.origins'))).toBe(true);

    received.splice(0);
    const ok = await run('pinned-steps', { input: { to: `${apiUrl}/pinned/b` } });
    expect(ok.status).toBe(200);
    expect(paths()).toEqual(['POST /pinned/a', 'POST /pinned/b']);
  });
});

describe('multi-step HTTP actions: deadline and access', () => {
  /** An API whose step answers 401 late; the token endpoint renews slowly when `slowRenewal`. */
  const lateUnauthorized = (slowRenewal: boolean) => {
    let unauthorized = false;
    respond = (req) => {
      if (req.url !== '/oauth/token') {
        unauthorized = true;
        return { status: 401, body: {}, delayMs: 700 };
      }
      return {
        status: 200,
        body: { access_token: 'm2m-token', expires_in: 3600 },
        delayMs: slowRenewal && unauthorized ? 2000 : 0,
      };
    };
  };

  it('cuts off the retry after a 401 at the deadline', async () => {
    lateUnauthorized(false);
    const started = Date.now();
    const res = await run('m2m-steps');
    expect(Date.now() - started).toBeLessThan(1400);
    expect(res.status).toBe(504);
    expect(results(res.body.steps)).toEqual(['only:failed']);
  });

  it('cuts off the token renewal after a 401 at the deadline', async () => {
    lateUnauthorized(true);
    const started = Date.now();
    const res = await run('m2m-steps');
    expect(Date.now() - started).toBeLessThan(1400);
    expect(res.status).toBe(504);
    expect(calls('/m2m/only')).toHaveLength(1);
  });

  it('starts no step after the deadline, and cuts off the one in flight', async () => {
    respond = () => ({ status: 200, body: {}, delayMs: 700 });
    const started = Date.now();
    const res = await run('slow-steps');
    expect(Date.now() - started).toBeLessThan(2500);
    expect(res.status).toBe(504);
    expect(results(res.body.steps)).toEqual(['one:ok', 'two:failed', 'three:not_attempted']);
    expect(calls('/slow/three')).toHaveLength(0);
  });

  it('is a 404 to a role without the action, run or retry, and calls nothing', async () => {
    expect(
      (await run('resolve-review', { records: ['1'], input: { decision: 'fraudulent' } }, viewer))
        .status,
    ).toBe(404);
    expect((await run('steps-not-granted')).status).toBe(404);
    expect((await retry('resolve-review', '1', viewer)).status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it('still requires a reason', async () => {
    const res = await run('three-with-undo', { reason: undefined });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

describe('multi-step HTTP actions at startup', () => {
  const moduleWith = (steps: number) => {
    const file = join(mkdtempSync(join(tmpdir(), 'warden-steps-')), 'actions.js');
    const list = Array.from(
      { length: steps },
      (_, i) => `{ name: 's${i}', url: 'https://api.example.com/${i}' }`,
    ).join(', ');
    writeFileSync(
      file,
      `export default ({ defineAction }) => [
        defineAction({ name: 'many-steps', label: 'Many', on: 'companies', target: 'none',
          http: { auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' }, steps: [${list}] } }),
      ];`,
    );
    return file;
  };
  const start = (env: Record<string, string>) =>
    createWarden({ env: { ...baseEnv(), ...env }, userTokens });

  it('refuses more than 5 steps, unless WARDEN_ACTION_MAX_STEPS allows them', async () => {
    const file = moduleWith(6);
    const err = await start({ WARDEN_ACTIONS: file }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsError);
    expect((err as ActionsError).problems).toContain(
      'action "many-steps": http.steps has 6 steps; at most 5 are allowed (WARDEN_ACTION_MAX_STEPS)',
    );
    const allowed = await start({ WARDEN_ACTIONS: file, WARDEN_ACTION_MAX_STEPS: '6' });
    await allowed.close();
    await expect(start({ WARDEN_ACTION_MAX_STEPS: '0' })).rejects.toThrow(
      /WARDEN_ACTION_MAX_STEPS/,
    );
  });
});
