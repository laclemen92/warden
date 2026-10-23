import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seal, unseal } from '../src/auth/session.js';
import { redactUrl } from '../src/logging.js';
import { createWarden } from '../src/warden.js';
import { authEnv, login, startTestIdp } from './helpers/auth.js';

type App = Awaited<ReturnType<typeof createWarden>>;

const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
);
const AUDIENCE = 'https://api.example.com';
const OFFLINE_SCOPES = 'openid email profile groups offline_access';
// Not under /api, so the session guard doesn't touch the session first: what accessTokenFor
// does to it is all that happens.
const TOKEN_ROUTE = '/test/access-token';

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
const apps: App[] = [];
const logLines: string[] = [];
/** Every token the tests saw, to check none of them were logged. */
const seenTokens = new Set<string>();

const start = async (env: Record<string, string> = {}) => {
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  });
  const app = await createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: EXAMPLE_CONFIG,
      ...authEnv(idp, { OIDC_AUDIENCE: AUDIENCE, OIDC_SCOPES: OFFLINE_SCOPES }),
      ...env,
    },
    logger: { level: 'debug', stream },
  });
  // Test-only: what a server-side caller (an HTTP action) gets.
  app.get(TOKEN_ROUTE, async (req) => {
    const token = await app.accessTokenFor(req);
    seenTokens.add(token);
    return { token };
  });
  apps.push(app);
  return app;
};

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
}, 120_000);

afterAll(async () => {
  for (const app of apps) await app.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const sessionToken = (cookie: string) => {
  const value = cookie.slice(cookie.indexOf('=') + 1);
  return value.slice(0, value.lastIndexOf('.'));
};
const tokenHash = (cookie: string) => createHash('sha256').update(sessionToken(cookie)).digest();

interface Row {
  access_token: string | null;
  refresh_token: string | null;
  access_token_expires_at: string | null;
  created_at: string;
  last_seen_at: string;
}
const rowOf = async (cookie: string) =>
  (
    await sqlPool.query<Row>(
      `select access_token, refresh_token, access_token_expires_at::text,
              created_at::text, last_seen_at::text
       from warden.sessions where token_hash = $1`,
      [tokenHash(cookie)],
    )
  ).rows[0];
const opened = (cookie: string, row: Row) => {
  const token = sessionToken(cookie);
  const access = row.access_token ? unseal(token, 'access_token', row.access_token) : undefined;
  const refresh = row.refresh_token ? unseal(token, 'refresh_token', row.refresh_token) : undefined;
  for (const t of [access, refresh]) if (t) seenTokens.add(t);
  return { access, refresh };
};
const expire = (cookie: string) =>
  sqlPool.query(
    `update warden.sessions set access_token_expires_at = now() + interval '30 seconds'
     where token_hash = $1`,
    [tokenHash(cookie)],
  );
const tokenOf = (app: App, cookie: string) =>
  app.inject({ method: 'GET', url: TOKEN_ROUTE, headers: { cookie } });
/** Whether the IdP accepts `token` as an access token. */
const userinfo = async (token: string) =>
  (await fetch(`${idp.issuer}/me`, { headers: { authorization: `Bearer ${token}` } })).status;
const refreshes = () => idp.grants.filter((g) => g.grantType === 'refresh_token');

const SIGN_IN_AGAIN = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'Sign in again to continue',
};

describe('storing tokens at login', () => {
  it('keeps the access and refresh tokens, encrypted under the session token', async () => {
    const app = await start();
    const cookie = await login(app, 'editor');
    const row = (await rowOf(cookie))!;
    for (const sealed of [row.access_token, row.refresh_token]) {
      expect(sealed).toMatch(/^v1\./);
    }
    expect(row.access_token_expires_at).not.toBeNull();
    const { access, refresh } = opened(cookie, row);
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    for (const plain of [access!, refresh!]) {
      const { rows } = await sqlPool.query(
        `select 1 from warden.sessions where row(sessions.*)::text like '%' || $1 || '%'`,
        [plain],
      );
      expect(rows).toEqual([]);
    }
    expect(await userinfo(access!)).toBe(200);

    // Each kind has its own key: another session's token, or another column, doesn't open it.
    expect(unseal(sessionToken(cookie), 'refresh_token', row.access_token!)).toBeUndefined();
    expect(unseal('other-session', 'access_token', row.access_token!)).toBeUndefined();
    expect(unseal('t', 'access_token', seal('t', 'access_token', 'x'))).toBe('x');

    // The fresh token is used as is, without asking the IdP.
    const before = refreshes().length;
    const res = await tokenOf(app, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: access });
    expect(refreshes()).toHaveLength(before);
  });

  it('keeps no refresh token without offline_access', async () => {
    const app = await start({ OIDC_SCOPES: 'openid email profile groups' });
    const cookie = await login(app, 'editor');
    const row = (await rowOf(cookie))!;
    expect(row.access_token).toMatch(/^v1\./);
    expect(row.refresh_token).toBeNull();
    expect((await tokenOf(app, cookie)).statusCode).toBe(200);

    // Once it's about to expire, there's no way to renew it.
    await expire(cookie);
    const before = refreshes().length;
    const res = await tokenOf(app, cookie);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(SIGN_IN_AGAIN);
    expect(refreshes()).toHaveLength(before);
  });

  it('keeps no tokens without an API audience', async () => {
    const app = await start({ OIDC_AUDIENCE: '' });
    const cookie = await login(app, 'editor');
    const row = (await rowOf(cookie))!;
    expect(row.access_token).toBeNull();
    expect(row.refresh_token).toBeNull();
    expect(row.access_token_expires_at).toBeNull();
    expect((await tokenOf(app, cookie)).json()).toEqual(SIGN_IN_AGAIN);
  });

  it('refuses requests without a live session', async () => {
    const app = await start({ WARDEN_SESSION_IDLE_TIMEOUT: '30m' });
    expect((await app.inject({ method: 'GET', url: TOKEN_ROUTE })).json()).toEqual(SIGN_IN_AGAIN);
    const cookie = await login(app, 'editor');
    const [name, value = ''] = cookie.split('=');
    // An unsigned cookie names no session.
    expect(
      (await tokenOf(app, `${name}=${value.slice(0, value.lastIndexOf('.'))}`)).json(),
    ).toEqual(SIGN_IN_AGAIN);
    await sqlPool.query(
      `update warden.sessions set last_seen_at = now() - interval '31 minutes'
       where token_hash = $1`,
      [tokenHash(cookie)],
    );
    expect((await tokenOf(app, cookie)).json()).toEqual(SIGN_IN_AGAIN);
  });
});

describe('refreshing', () => {
  it('refreshes an expiring token once for concurrent callers, without extending the session', async () => {
    const app = await start();
    const cookie = await login(app, 'editor');
    const before = (await rowOf(cookie))!;
    const old = opened(cookie, before);
    await expire(cookie);

    const count = refreshes().length;
    const results = await Promise.all(Array.from({ length: 8 }, () => tokenOf(app, cookie)));
    const tokens = new Set(results.map((r) => r.json<{ token: string }>().token));
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(tokens.size).toBe(1);
    const [fresh] = tokens;
    expect(fresh).not.toBe(old.access);
    expect(refreshes().slice(count)).toEqual([{ grantType: 'refresh_token', ok: true }]);
    expect(await userinfo(fresh!)).toBe(200);

    const after = (await rowOf(cookie))!;
    expect(opened(cookie, after).access).toBe(fresh);
    expect(after.access_token_expires_at! > before.access_token_expires_at!).toBe(true);
    expect(after.created_at).toBe(before.created_at);
    expect(after.last_seen_at).toBe(before.last_seen_at);
    // The new token is fresh, so the next call doesn't refresh.
    expect((await tokenOf(app, cookie)).json()).toEqual({ token: fresh });
    expect(refreshes()).toHaveLength(count + 1);
  });

  it('refreshes once across Warden instances sharing the database', async () => {
    const [a, b] = [await start(), await start()];
    const cookie = await login(a, 'editor');
    await expire(cookie);
    const count = refreshes().length;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => tokenOf(i % 2 ? a : b, cookie)),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
    expect(new Set(results.map((r) => r.json<{ token: string }>().token)).size).toBe(1);
    expect(refreshes().slice(count)).toEqual([{ grantType: 'refresh_token', ok: true }]);
  });

  it('refreshes more sessions at once than the connection pool holds', async () => {
    const app = await start();
    // The main pool has 10 connections; no refresh may hold one while it waits for another.
    const cookies = await Promise.all(Array.from({ length: 14 }, () => login(app, 'editor')));
    for (const cookie of cookies) await expire(cookie);
    const count = refreshes().length;
    const results = await Promise.all(cookies.map((cookie) => tokenOf(app, cookie)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(14).fill(200));
    expect(new Set(results.map((r) => r.json<{ token: string }>().token)).size).toBe(14);
    expect(refreshes().slice(count)).toEqual(
      Array(14).fill({ grantType: 'refresh_token', ok: true }),
    );
  }, 30_000);

  it('waits for another instance refreshing, and takes over a claim it abandoned', async () => {
    const app = await start();
    const cookie = await login(app, 'editor');
    const old = opened(cookie, (await rowOf(cookie))!);
    await expire(cookie);
    // As an instance that crashed mid-refresh would leave it.
    await sqlPool.query(
      `update warden.sessions set api_tokens_refreshing_until = now() + interval '1 second'
       where token_hash = $1`,
      [tokenHash(cookie)],
    );
    const count = refreshes().length;
    const started = Date.now();
    const res = await tokenOf(app, cookie);
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(res.json<{ token: string }>().token).not.toBe(old.access);
    expect(refreshes().slice(count)).toEqual([{ grantType: 'refresh_token', ok: true }]);
    const { rows } = await sqlPool.query<{ until: string | null }>(
      `select api_tokens_refreshing_until::text as until from warden.sessions
       where token_hash = $1`,
      [tokenHash(cookie)],
    );
    expect(rows[0]?.until).toBeNull();
  });

  it('asks the user to sign in again when the IdP rejects the refresh token', async () => {
    const app = await start();
    const cookie = await login(app, 'editor');
    const { refresh } = opened(cookie, (await rowOf(cookie))!);
    // As an IdP admin removing the user, or the user revoking Warden, would.
    const revoked = await fetch(`${idp.issuer}/token/revocation`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('warden:test-client-secret').toString('base64')}`,
      },
      body: new URLSearchParams({ token: refresh!, token_type_hint: 'refresh_token' }),
    });
    expect(revoked.status).toBe(200);
    await expire(cookie);

    const count = refreshes().length;
    const res = await tokenOf(app, cookie);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(SIGN_IN_AGAIN);
    expect(refreshes().slice(count)).toEqual([{ grantType: 'refresh_token', ok: false }]);
    // The rejected tokens are cleared, so later calls don't ask the IdP again.
    const row = (await rowOf(cookie))!;
    expect(row.access_token).toBeNull();
    expect(row.refresh_token).toBeNull();
    expect((await tokenOf(app, cookie)).json()).toEqual(SIGN_IN_AGAIN);
    expect(refreshes()).toHaveLength(count + 1);
    // Warden's own session isn't affected.
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it('treats a tampered stored token as missing', async () => {
    const app = await start();
    const cookie = await login(app, 'editor');
    // The refresh token in the access token's place: wrong key, so it doesn't open.
    await sqlPool.query(
      `update warden.sessions set access_token = refresh_token, refresh_token = access_token
       where token_hash = $1`,
      [tokenHash(cookie)],
    );
    const count = refreshes().length;
    expect((await tokenOf(app, cookie)).json()).toEqual(SIGN_IN_AGAIN);
    expect(refreshes()).toHaveLength(count);
  });
});

describe('deleting tokens', () => {
  const stored = async () =>
    (
      await sqlPool.query<{ n: number }>(
        `select count(*)::int as n from warden.sessions
         where access_token is not null or refresh_token is not null`,
      )
    ).rows[0]!.n;

  it('deletes them with the session at logout', async () => {
    const app = await start();
    const cookie = await login(app, 'viewer');
    expect(await rowOf(cookie)).toBeDefined();
    const before = await stored();
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    expect(await rowOf(cookie)).toBeUndefined();
    expect(await stored()).toBe(before - 1);
    expect((await tokenOf(app, cookie)).json()).toEqual(SIGN_IN_AGAIN);
  });

  it('deletes them when an admin revokes the sessions', async () => {
    const app = await start();
    const admin = await login(app, 'admin');
    const cookies = [await login(app, 'viewer'), await login(app, 'viewer')];
    for (const cookie of cookies) expect((await rowOf(cookie))?.access_token).toBeTruthy();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/roles/sessions',
      headers: { cookie: admin },
      payload: { subject: 'viewer' },
    });
    expect(res.statusCode, res.body).toBe(200);
    for (const cookie of cookies) {
      expect(await rowOf(cookie)).toBeUndefined();
      expect((await tokenOf(app, cookie)).json()).toEqual(SIGN_IN_AGAIN);
    }
  });
});

describe('never exposing tokens', () => {
  it('keeps them out of responses, the audit log, and logs', async () => {
    const app = await start();
    const cookie = await login(app, 'admin');
    opened(cookie, (await rowOf(cookie))!);
    await expire(cookie);
    expect((await tokenOf(app, cookie)).statusCode).toBe(200);

    const bodies = await Promise.all(
      ['/api/me', '/api/schema', '/api/admin/roles'].map(async (url) => {
        const res = await app.inject({ method: 'GET', url, headers: { cookie } });
        return res.body + JSON.stringify(res.headers);
      }),
    );
    const { rows } = await sqlPool.query<{ entry: string }>(
      `select row(audit_log.*)::text as entry from warden.audit_log`,
    );

    expect(seenTokens.size).toBeGreaterThan(0);
    const logs = logLines.join('');
    expect(logs).not.toBe('');
    for (const token of seenTokens) {
      expect(logs).not.toContain(token);
      for (const body of bodies) expect(body).not.toContain(token);
      for (const { entry } of rows) expect(entry).not.toContain(token);
    }
  });

  it('redacts refresh_token in logged URLs', () => {
    expect(redactUrl('/x?refresh_token=abc&q=1')).toBe('/x?refresh_token=%5Bredacted%5D&q=1');
  });
});
