import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MockOidc } from '@wardenhq/mock-oidc';
import { readExampleSql, startPostgres, type TestDatabase } from '@wardenhq/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAuthSettings, parseDuration } from '../src/auth/settings.js';
import { safeReturnTo } from '../src/routes/auth.js';
import { createWarden } from '../src/warden.js';
import {
  ALLOW_ALL_CONFIG,
  authEnv,
  beginLogin,
  callback,
  cookiesFrom,
  HTTPS_PUBLIC_URL,
  idpRequest,
  login,
  logoutAtIdp,
  PUBLIC_URL,
  signInAtIdp,
  startTestIdp,
  writeConfig,
} from './helpers/auth.js';

type App = Awaited<ReturnType<typeof createWarden>>;

const EXAMPLE_CONFIG = fileURLToPath(
  new URL('../../../examples/basic/warden.config.yaml', import.meta.url),
);

let db: TestDatabase;
let sqlPool: pg.Pool;
let idp: MockOidc;
let app: App;

const start = (env: Record<string, string> = {}) =>
  createWarden({
    env: {
      DATABASE_URL: db.connectionString,
      WARDEN_CONFIG: writeConfig(ALLOW_ALL_CONFIG),
      ...authEnv(idp),
      ...env,
    },
  });

beforeAll(async () => {
  db = await startPostgres({
    sql: [await readExampleSql('basic/schema.sql'), await readExampleSql('basic/seed.sql')],
  });
  sqlPool = new pg.Pool({ connectionString: db.connectionString });
  idp = await startTestIdp();
  app = await start();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await idp?.close();
  await sqlPool?.end();
  await db?.stop();
});

const get = (url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie } } : {}) });

const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };

describe('unauthenticated requests', () => {
  it.each(['/api/schema', '/api/me', '/api/entities/users', '/api/entities/users/1', '/api/nope'])(
    '%s returns 401',
    async (url) => {
      const res = await get(url);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED);
    },
  );

  it('guards percent-encoded paths that the router decodes to /api', async () => {
    // Fastify routes /%61pi/schema to /api/schema, so a raw-URL prefix check alone would miss it.
    const res = await get('/%61pi/schema');
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unsigned, forged, or re-signed session cookie', async () => {
    const real = await login(app);
    const [name, value = ''] = real.split('=');
    const token = value.slice(0, value.lastIndexOf('.'));
    for (const cookie of [
      `${name}=${token}`,
      `${name}=${token}.forgedsignature`,
      `${name}=${'A'.repeat(43)}.${value.slice(value.lastIndexOf('.') + 1)}`,
    ]) {
      expect((await get('/api/me', cookie)).statusCode).toBe(401);
    }
  });

  it('leaves health checks public', async () => {
    expect((await get('/healthz')).statusCode).toBe(200);
  });
});

describe('login', () => {
  it('logs in through the IdP and serves /api/me', async () => {
    const cookie = await login(app, 'editor');
    const me = await get('/api/me', cookie);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      sub: 'editor',
      email: 'editor@example.com',
      name: 'Eddie Editor',
      roles: [],
      admin: [],
    });
    expect((await get('/api/schema', cookie)).statusCode).toBe(200);
  });

  it('sends PKCE, state, and nonce to the IdP', async () => {
    const { authorizeUrl } = await beginLogin(app);
    const url = new URL(authorizeUrl);
    expect(url.origin).toBe(idp.issuer);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    for (const param of ['code_challenge', 'state', 'nonce']) {
      expect(url.searchParams.get(param)).toBeTruthy();
    }
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid email profile groups');
  });

  it('sets an httpOnly, SameSite=Lax session cookie', async () => {
    const { authorizeUrl, cookies } = await beginLogin(app);
    const res = await callback(app, await signInAtIdp(authorizeUrl, 'viewer'), cookies);
    const setCookie = [res.headers['set-cookie'] ?? []].flat();
    const session = setCookie.find((c) => c.startsWith('warden_session='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/Max-Age=43200/);
    // The login cookie is cleared once used.
    expect(setCookie.find((c) => c.startsWith('warden_login='))).toMatch(/Max-Age=0/);
  });

  it('uses a Secure __Host- cookie when Warden is served over https', async () => {
    const secureApp = await start({ WARDEN_PUBLIC_URL: HTTPS_PUBLIC_URL });
    try {
      const { authorizeUrl, cookies } = await beginLogin(secureApp);
      expect([...cookies.keys()]).toEqual(['__Host-warden_login']);
      expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(
        `${HTTPS_PUBLIC_URL}/auth/callback`,
      );
      const res = await callback(secureApp, await signInAtIdp(authorizeUrl, 'viewer'), cookies);
      const session = [res.headers['set-cookie'] ?? []]
        .flat()
        .find((c) => c.startsWith('__Host-warden_session='));
      expect(session).toMatch(/; Secure/);
      expect(session).toMatch(/HttpOnly/);
      expect(session).toMatch(/SameSite=Lax/);
    } finally {
      await secureApp.close();
    }
  });

  it('stores only a hash of the session token', async () => {
    const cookie = await login(app, 'admin');
    const value = cookie.slice(cookie.indexOf('=') + 1);
    const token = value.slice(0, value.lastIndexOf('.'));
    const { rows } = await sqlPool.query<{ n: string }>(
      `select count(*) as n from warden.sessions where token_hash = $1`,
      [createHash('sha256').update(token).digest()],
    );
    expect(rows[0]?.n).toBe('1');
    const { rows: raw } = await sqlPool.query(
      `select 1 from warden.sessions where encode(token_hash, 'escape') like '%' || $1 || '%'`,
      [token],
    );
    expect(raw).toEqual([]);
  });

  it('redirects to a same-origin returnTo, and to / for anything else', async () => {
    const landing = async (returnTo: string) => {
      const { authorizeUrl, cookies } = await beginLogin(app, returnTo);
      const res = await callback(app, await signInAtIdp(authorizeUrl, 'viewer'), cookies);
      return res.headers.location;
    };
    expect(await landing('/entities/users?q=a')).toBe('/entities/users?q=a');
    for (const evil of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'evil']) {
      expect(await landing(evil)).toBe('/');
    }
  });

  it('fails without the login cookie (another browser, or expired)', async () => {
    const { authorizeUrl } = await beginLogin(app);
    const res = await callback(app, await signInAtIdp(authorizeUrl, 'admin'), new Map());
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=login_failed');
    expect(cookiesFrom(res.headers['set-cookie']).get('warden_session')).toBeUndefined();
  });

  it("fails with another login's cookie (state mismatch)", async () => {
    const first = await beginLogin(app);
    const second = await beginLogin(app);
    const res = await callback(app, await signInAtIdp(first.authorizeUrl, 'admin'), second.cookies);
    expect(res.headers.location).toBe('/login?error=login_failed');
    expect(cookiesFrom(res.headers['set-cookie']).get('warden_session')).toBeUndefined();
  });

  it('fails with a tampered login cookie', async () => {
    const { authorizeUrl, cookies } = await beginLogin(app);
    const signed = cookies.get('warden_login') ?? '';
    const tampered = new Map([['warden_login', signed.replace(/^[^.]/, 'x')]]);
    const res = await callback(app, await signInAtIdp(authorizeUrl, 'admin'), tampered);
    expect(res.headers.location).toBe('/login?error=login_failed');
  });

  it('refuses to replay an authorization code', async () => {
    const { authorizeUrl, cookies } = await beginLogin(app);
    const url = await signInAtIdp(authorizeUrl, 'admin');
    expect((await callback(app, url, cookies)).headers.location).toBe('/');
    const replay = await callback(app, url, cookies);
    expect(replay.headers.location).toBe('/login?error=login_failed');
  });

  it('fails when the user cancels at the IdP', async () => {
    const { authorizeUrl, cookies } = await beginLogin(app);
    const interaction = await fetch(authorizeUrl, { redirect: 'manual' });
    const jar = cookiesFrom(interaction.headers.getSetCookie());
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    const location = new URL(interaction.headers.get('location')!, idp.issuer).href;
    const resume = await fetch(`${location}/abort`, {
      method: 'POST',
      headers,
      redirect: 'manual',
    });
    const back = await fetch(new URL(resume.headers.get('location')!, idp.issuer), {
      headers,
      redirect: 'manual',
    });
    const res = await callback(app, new URL(back.headers.get('location')!), cookies);
    expect(res.headers.location).toBe('/login?error=login_failed');
  });

  it('redirects to the login page with a generic error when the IdP is down', async () => {
    const downApp = await start({ OIDC_ISSUER: 'http://127.0.0.1:9' });
    try {
      const res = await downApp.inject({ method: 'GET', url: '/auth/login' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login?error=login_failed');
    } finally {
      await downApp.close();
    }
  });
});

describe('roles', () => {
  let rolesApp: App;
  beforeAll(async () => {
    rolesApp = await start({ WARDEN_CONFIG: EXAMPLE_CONFIG });
  });
  afterAll(() => rolesApp?.close());

  const me = async (sub: string) => {
    const cookie = await login(rolesApp, sub);
    const res = await rolesApp.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return res.json<{ roles: string[] }>().roles;
  };

  it('resolves roles from group claims and email domain, visible at /api/me', async () => {
    expect(await me('viewer')).toEqual(['viewer']);
    expect(await me('editor')).toEqual(['ops', 'viewer']);
    expect(await me('admin')).toEqual(['admin', 'viewer']);
  });

  it('lets everyone in with no roles when access.allowAll is on', async () => {
    const cookie = await login(app, 'outsider');
    const res = await get('/api/me', cookie);
    expect(res.json()).toMatchObject({ sub: 'outsider', roles: [] });
  });

  it('denies a user who matches no rule, without creating a session', async () => {
    const { rows: before } = await sqlPool.query(`select count(*) from warden.sessions`);
    const { authorizeUrl, cookies } = await beginLogin(rolesApp);
    const res = await callback(rolesApp, await signInAtIdp(authorizeUrl, 'outsider'), cookies);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=access_denied');
    expect(cookiesFrom(res.headers['set-cookie']).get('warden_session')).toBeUndefined();
    const { rows: after } = await sqlPool.query(`select count(*) from warden.sessions`);
    expect(after).toEqual(before);
  });

  it('denies existing sessions that no longer match after a config change', async () => {
    // Sessions are shared by every app on this database, so one from the open app carries over.
    const cookie = await login(app, 'outsider');
    expect((await get('/api/me', cookie)).statusCode).toBe(200);
    for (const url of ['/api/me', '/api/schema', '/api/entities/users']) {
      const res = await rolesApp.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED);
    }
  });

  it('ignores email domains when the email is unverified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warden-roles-'));
    const config = join(dir, 'warden.config.yaml');
    writeFileSync(
      config,
      'roles: { viewer: {} }\naccess: { emailDomains: { example.com: [viewer] } }\n',
    );
    const domainApp = await start({ WARDEN_CONFIG: config });
    try {
      const cookie = await login(domainApp, 'viewer');
      // Rewrite the stored claims, as an IdP that doesn't verify emails would have sent them.
      await sqlPool.query(
        `update warden.sessions set claims = claims || '{"email_verified": false}'
         where subject = 'viewer'`,
      );
      const res = await domainApp.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(res.statusCode).toBe(401);
    } finally {
      await domainApp.close();
    }
  });
});

describe('sessions', () => {
  const backdate = (column: string, interval: string) =>
    sqlPool.query(`update warden.sessions set ${column} = now() - $1::interval`, [interval]);

  it('logout revokes the session server-side and clears the cookie', async () => {
    const cookie = await login(app, 'editor');
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/^warden_session=;.*Max-Age=0/);
    // Replaying the old cookie no longer works.
    expect((await get('/api/me', cookie)).statusCode).toBe(401);
  });

  it('signing in again revokes the session the browser already held', async () => {
    const old = await login(app, 'editor');
    const other = await login(app, 'editor');
    const [name, value = ''] = old.split('=');

    const { authorizeUrl, cookies } = await beginLogin(app);
    cookies.set(name!, value);
    const res = await callback(app, await signInAtIdp(authorizeUrl, 'editor'), cookies);
    expect(res.statusCode).toBe(302);
    const fresh = cookiesFrom(res.headers['set-cookie']).get(name!);
    expect(fresh).toBeTruthy();

    // A copy of the old token is useless now; the new one, and other browsers, still work.
    expect((await get('/api/me', old)).statusCode).toBe(401);
    expect((await get('/api/me', `${name}=${fresh}`)).statusCode).toBe(200);
    expect((await get('/api/me', other)).statusCode).toBe(200);
  });

  it('signing in with an invalid session cookie still works and revokes nothing', async () => {
    const other = await login(app, 'viewer');
    const [name, value = ''] = other.split('=');
    const { authorizeUrl, cookies } = await beginLogin(app);
    // The raw token without its signature, as if someone tried to name a session to delete.
    cookies.set(name!, value.slice(0, value.lastIndexOf('.')));
    const res = await callback(app, await signInAtIdp(authorizeUrl, 'viewer'), cookies);
    expect(res.headers.location).toBe('/');
    expect((await get('/api/me', other)).statusCode).toBe(200);
  });

  it('logout without a session still succeeds', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(200);
  });

  it('logout is not available over GET', async () => {
    const cookie = await login(app, 'viewer');
    await app.inject({ method: 'GET', url: '/auth/logout', headers: { cookie } });
    expect((await get('/api/me', cookie)).statusCode).toBe(200);
  });

  it('expires after the idle timeout', async () => {
    const shortApp = await start({ WARDEN_SESSION_IDLE_TIMEOUT: '30m' });
    try {
      const cookie = await login(shortApp, 'viewer');
      await backdate('last_seen_at', '29 minutes');
      const res = await shortApp.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      // That request reset the idle clock; now let it lapse.
      await backdate('last_seen_at', '31 minutes');
      const expired = await shortApp.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(expired.statusCode).toBe(401);
    } finally {
      await shortApp.close();
    }
  });

  it('expires after the absolute timeout even while active', async () => {
    const shortApp = await start({
      WARDEN_SESSION_IDLE_TIMEOUT: '1h',
      WARDEN_SESSION_ABSOLUTE_TIMEOUT: '1h',
    });
    try {
      const cookie = await login(shortApp, 'viewer');
      await backdate('created_at', '61 minutes');
      const res = await shortApp.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(res.statusCode).toBe(401);
    } finally {
      await shortApp.close();
    }
  });
});

describe('IdP logout', () => {
  const logout = (cookie?: string) =>
    app.inject({ method: 'POST', url: '/auth/logout', ...(cookie ? { headers: { cookie } } : {}) });
  const jwtPayload = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
  /** Where the IdP sends a browser with `jar`'s cookies when Warden starts a login. */
  const authorizeAs = async (jar: Map<string, string>) =>
    (await idpRequest(jar, (await beginLogin(app)).authorizeUrl)).location;

  it('ends the IdP session too, so the next sign-in asks who you are', async () => {
    const jar = new Map<string, string>();
    const { authorizeUrl, cookies } = await beginLogin(app);
    const res = await callback(app, await signInAtIdp(authorizeUrl, 'editor', jar), cookies);
    const [name, value] = [...cookiesFrom(res.headers['set-cookie'])].find(([k]) =>
      k.includes('warden_session'),
    )!;
    const cookie = `${name}=${value}`;
    // The IdP still has a session: without logging out there, the next login is silent.
    expect(await authorizeAs(jar)).toMatch(new RegExp(`^${PUBLIC_URL}/auth/callback\\?`));

    const out = await logout(cookie);
    expect(out.statusCode).toBe(200);
    const { redirectTo } = out.json<{ redirectTo: string }>();
    const url = new URL(redirectTo);
    expect(url.origin).toBe(idp.issuer);
    expect(url.searchParams.get('client_id')).toBe('warden');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_URL}/`);
    expect(jwtPayload(url.searchParams.get('id_token_hint') ?? '')).toMatchObject({
      sub: 'editor',
      aud: 'warden',
    });
    expect((await get('/api/me', cookie)).statusCode).toBe(401);

    expect(await logoutAtIdp(redirectTo, jar)).toBe(`${PUBLIC_URL}/`);
    expect(new URL((await authorizeAs(jar))!).pathname).toMatch(/^\/interaction\//);
  });

  it('sends a browser without a session to the IdP without a hint', async () => {
    const out = await logout();
    expect(out.statusCode).toBe(200);
    const url = new URL(out.json<{ redirectTo: string }>().redirectTo);
    expect(url.searchParams.get('client_id')).toBe('warden');
    expect(url.searchParams.has('id_token_hint')).toBe(false);
  });

  it("doesn't keep the ID token on a session after logout", async () => {
    const cookie = await login(app, 'viewer');
    const count = async () =>
      (
        await sqlPool.query(
          `select count(*)::int as n from warden.sessions where id_token is not null`,
        )
      ).rows[0].n as number;
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await logout(cookie);
    expect(await count()).toBe(before - 1);
  });

  it("only logs out of Warden when the IdP doesn't support it", async () => {
    const plainIdp = await startTestIdp({ endSession: false });
    const plainApp = await start({ OIDC_ISSUER: plainIdp.issuer });
    try {
      const cookie = await login(plainApp, 'editor');
      const out = await plainApp.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie },
      });
      expect(out.statusCode).toBe(204);
      expect(out.body).toBe('');
      const me = await plainApp.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(me.statusCode).toBe(401);
    } finally {
      await plainApp.close();
      await plainIdp.close();
    }
  });

  it('still logs out of Warden when the IdP is down', async () => {
    const downApp = await start({ OIDC_ISSUER: 'http://127.0.0.1:9' });
    try {
      const out = await downApp.inject({ method: 'POST', url: '/auth/logout' });
      expect(out.statusCode).toBe(204);
      expect(String(out.headers['set-cookie'])).toMatch(/warden_session=;.*Max-Age=0/);
    } finally {
      await downApp.close();
    }
  });
});

describe('logging', () => {
  it('never logs the authorization code or state', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const loggedApp = await createWarden({
      env: { DATABASE_URL: db.connectionString, WARDEN_CONFIG: EXAMPLE_CONFIG, ...authEnv(idp) },
      logger: { level: 'info', stream },
    });
    try {
      const { authorizeUrl, cookies } = await beginLogin(loggedApp);
      const url = await signInAtIdp(authorizeUrl, 'viewer');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      expect(code).toBeTruthy();
      expect(state).toBeTruthy();
      expect((await callback(loggedApp, url, cookies)).statusCode).toBe(302);

      const callbackLines = lines.filter((l) => l.includes('/auth/callback'));
      expect(callbackLines.length).toBeGreaterThan(0);
      expect(callbackLines.join('')).toContain('/auth/callback?[redacted]');
      for (const line of lines) {
        expect(line).not.toContain(code);
        expect(line).not.toContain(state);
      }
    } finally {
      await loggedApp.close();
    }
  });
});

describe('settings', () => {
  const valid = {
    WARDEN_PUBLIC_URL: 'https://warden.example.com',
    OIDC_ISSUER: 'https://accounts.example.com',
    OIDC_CLIENT_ID: 'warden',
    OIDC_CLIENT_SECRET: 'secret',
    WARDEN_SESSION_SECRET: 'x'.repeat(32),
  };

  it('parses durations', () => {
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('30m')).toBe(1800);
    expect(parseDuration('8h')).toBe(28_800);
    expect(parseDuration('7d')).toBe(604_800);
    for (const bad of ['', '0', '-5m', '1.5h', '2w', 'soon'])
      expect(parseDuration(bad)).toBeUndefined();
  });

  it('defaults scopes and timeouts', () => {
    expect(parseAuthSettings(valid)).toMatchObject({
      scopes: 'openid email profile',
      idleTimeoutSeconds: 7200,
      absoluteTimeoutSeconds: 43_200,
    });
  });

  it('lists every missing variable at once', () => {
    expect(() => parseAuthSettings({})).toThrow(
      /WARDEN_PUBLIC_URL is required[\s\S]*OIDC_ISSUER is required[\s\S]*OIDC_CLIENT_ID is required[\s\S]*OIDC_CLIENT_SECRET is required[\s\S]*WARDEN_SESSION_SECRET is required/,
    );
  });

  it.each([
    [{ OIDC_ISSUER: 'http://idp.example.com' }, /OIDC_ISSUER must use https/],
    [{ WARDEN_PUBLIC_URL: 'http://warden.example.com' }, /WARDEN_PUBLIC_URL must use https/],
    [{ OIDC_ISSUER: 'not a url' }, /OIDC_ISSUER must be a URL/],
    [{ WARDEN_SESSION_SECRET: 'short' }, /at least 32 characters/],
    [{ OIDC_SCOPES: 'email profile' }, /must include openid/],
    [{ WARDEN_SESSION_IDLE_TIMEOUT: 'forever' }, /WARDEN_SESSION_IDLE_TIMEOUT must be a duration/],
    [
      { WARDEN_SESSION_IDLE_TIMEOUT: '2d', WARDEN_SESSION_ABSOLUTE_TIMEOUT: '1d' },
      /must not exceed/,
    ],
  ])('rejects %o', (overrides, message) => {
    expect(() => parseAuthSettings({ ...valid, ...overrides })).toThrow(message);
  });

  it('allows http for localhost only', () => {
    expect(() =>
      parseAuthSettings({
        ...valid,
        OIDC_ISSUER: 'http://localhost:9400',
        WARDEN_PUBLIC_URL: 'http://127.0.0.1:3000',
      }),
    ).not.toThrow();
  });

  it('fails startup on invalid auth settings', async () => {
    await expect(
      createWarden({ env: { DATABASE_URL: db.connectionString, OIDC_ISSUER: idp.issuer } }),
    ).rejects.toThrow(/Invalid auth settings/);
  });

  it('only accepts same-origin paths as returnTo', () => {
    expect(safeReturnTo('/a/b?c=d#e')).toBe('/a/b?c=d#e');
    for (const bad of [undefined, 42, '', 'a', '//x', '/\\x', 'https://x', '/a\nb']) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
});
