import * as oidc from 'openid-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_USERS, startMockOidc, type MockOidc } from '../src/index.js';

const CLIENT_ID = 'warden';
const CLIENT_SECRET = 'test-secret';
const REDIRECT_URI = 'http://localhost:3000/api/auth/callback';

let idp: MockOidc;
let config: oidc.Configuration;

beforeAll(async () => {
  idp = await startMockOidc({
    clients: [
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUris: [REDIRECT_URI],
        postLogoutRedirectUris: ['http://localhost:3000/'],
      },
    ],
  });
  config = await discover(CLIENT_SECRET);
});

afterAll(() => idp.close());

function discover(secret: string) {
  return oidc.discovery(new URL(idp.issuer), CLIENT_ID, secret, undefined, {
    execute: [oidc.allowInsecureRequests],
  });
}

/** A minimal browser: follows nothing automatically and keeps cookies by name. */
function browser() {
  const cookies = new Map<string, string>();
  return async (url: string | URL, init: RequestInit = {}) => {
    const res = await fetch(new URL(url, idp.issuer), {
      ...init,
      redirect: 'manual',
      headers: {
        ...(init.headers as Record<string, string>),
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const eq = pair.indexOf('=');
      cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  };
}

function location(res: Response): string {
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  const value = res.headers.get('location');
  expect(value).toBeTruthy();
  return new URL(value!, idp.issuer).href;
}

function postForm(go: ReturnType<typeof browser>, url: string, body: Record<string, string>) {
  return go(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

async function startLogin(go: ReturnType<typeof browser>, scope = 'openid email profile groups') {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const authUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: REDIRECT_URI,
    scope,
    state,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  const interaction = location(await go(authUrl));
  return { codeVerifier, state, interaction };
}

/** Drive authorization code + PKCE through the login page, then exchange the code. */
async function login(sub: string, scope?: string) {
  const go = browser();
  const { codeVerifier, state, interaction } = await startLogin(go, scope);

  const loginPage = await go(interaction);
  expect(loginPage.status).toBe(200);
  expect(await loginPage.text()).toContain(`value="${sub}"`);

  const resume = location(await postForm(go, `${interaction}/login`, { user: sub }));
  const callback = location(await go(resume));
  expect(callback.startsWith(REDIRECT_URI)).toBe(true);

  const tokens = await oidc.authorizationCodeGrant(config, new URL(callback), {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
  });
  return { go, tokens };
}

describe('mock OIDC provider', () => {
  it('advertises the groups scope and S256 PKCE', () => {
    const metadata = config.serverMetadata();
    expect(metadata.issuer).toBe(idp.issuer);
    expect(metadata.scopes_supported).toEqual(
      expect.arrayContaining(['openid', 'email', 'profile', 'groups']),
    );
    expect(metadata.code_challenge_methods_supported).toContain('S256');
    expect(metadata.end_session_endpoint).toBeTruthy();
  });

  it.each(MOCK_USERS)('signs in $sub with email, name, and groups claims', async (user) => {
    const { tokens } = await login(user.sub);
    const expected = {
      sub: user.sub,
      email: user.email,
      email_verified: true,
      name: user.name,
      groups: user.groups,
    };
    expect(tokens.claims()).toMatchObject({ ...expected, iss: idp.issuer, aud: CLIENT_ID });

    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, user.sub);
    expect(userinfo).toMatchObject(expected);
  });

  it('includes the viewer, editor, and admin test users', () => {
    expect(MOCK_USERS.map((u) => u.sub)).toEqual(
      expect.arrayContaining(['viewer', 'editor', 'admin']),
    );
  });

  it('omits claims for scopes that were not requested', async () => {
    const { tokens } = await login('admin', 'openid email');
    const claims = tokens.claims();
    expect(claims).toMatchObject({ sub: 'admin', email: 'admin@example.com' });
    expect(claims).not.toHaveProperty('groups');
    expect(claims).not.toHaveProperty('name');
  });

  it('rejects an unknown user', async () => {
    const go = browser();
    const { interaction } = await startLogin(go);
    const res = await postForm(go, `${interaction}/login`, { user: 'mallory' });
    expect(res.status).toBe(400);
  });

  it('rejects an interaction without its browser cookies', async () => {
    const { interaction } = await startLogin(browser());
    const res = await postForm(browser(), `${interaction}/login`, { user: 'admin' });
    expect(res.status).toBe(400);
  });

  it('returns access_denied when the user cancels', async () => {
    const go = browser();
    const { interaction } = await startLogin(go);
    const resume = location(await postForm(go, `${interaction}/abort`, {}));
    const callback = new URL(location(await go(resume)));
    expect(callback.searchParams.get('error')).toBe('access_denied');
  });

  it('requires PKCE', async () => {
    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: oidc.randomState(),
    });
    const callback = new URL(location(await browser()(authUrl)));
    expect(callback.searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses an unregistered redirect_uri without redirecting', async () => {
    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: 'https://attacker.example/callback',
      scope: 'openid',
      code_challenge: await oidc.calculatePKCECodeChallenge(oidc.randomPKCECodeVerifier()),
      code_challenge_method: 'S256',
    });
    const res = await browser()(authUrl);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('rejects a token request with the wrong client secret', async () => {
    const go = browser();
    const { codeVerifier, state, interaction } = await startLogin(go);
    const resume = location(await postForm(go, `${interaction}/login`, { user: 'viewer' }));
    const callback = location(await go(resume));

    const wrong = await discover('not-the-secret');
    await expect(
      oidc.authorizationCodeGrant(wrong, new URL(callback), {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
      }),
    ).rejects.toMatchObject({ error: 'invalid_client' });
  });

  it('ends the session on RP-initiated logout', async () => {
    const { go, tokens } = await login('editor');
    const logoutUrl = oidc.buildEndSessionUrl(config, {
      id_token_hint: tokens.id_token!,
      post_logout_redirect_uri: 'http://localhost:3000/',
    });
    const confirm = await go(logoutUrl);
    expect(confirm.status).toBe(200);
    const html = await confirm.text();
    const action = /action="([^"]+)"/.exec(html)?.[1];
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
    expect(action && xsrf).toBeTruthy();

    const done = await postForm(go, action!, { xsrf: xsrf!, logout: 'yes' });
    expect(location(done)).toBe('http://localhost:3000/');

    // The next authorization prompts for a user again instead of reusing the session.
    const { interaction } = await startLogin(go);
    expect(new URL(interaction).pathname).toMatch(/^\/interaction\//);
  });
});
