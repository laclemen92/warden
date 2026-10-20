import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockOidc, type MockOidc } from '@wardenhq/mock-oidc';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

export const PUBLIC_URL = 'http://localhost:3000';
export const HTTPS_PUBLIC_URL = 'https://warden.test';
const CLIENT_ID = 'warden';
const CLIENT_SECRET = 'test-client-secret';

export function startTestIdp({ endSession = true } = {}): Promise<MockOidc> {
  return startMockOidc({
    clients: [
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUris: [PUBLIC_URL, HTTPS_PUBLIC_URL].map((url) => `${url}/auth/callback`),
        postLogoutRedirectUris: [PUBLIC_URL, HTTPS_PUBLIC_URL].map((url) => `${url}/`),
      },
    ],
    endSession,
  });
}

/** Env for createWarden that points auth at the test IdP. */
export function authEnv(idp: MockOidc, overrides: Record<string, string> = {}) {
  return {
    WARDEN_PUBLIC_URL: PUBLIC_URL,
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_SCOPES: 'openid email profile groups',
    WARDEN_SESSION_SECRET: 'test-session-secret-that-is-long-enough',
    ...overrides,
  };
}

/** Write a config file to a fresh temp directory and return its path. */
export function writeConfig(source: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'warden-test-')), 'warden.config.yaml');
  writeFileSync(file, source);
  return file;
}

/** Defaults, plus the opt-in that lets every IdP user in (Warden refuses to start without `access`). */
export const ALLOW_ALL_CONFIG = 'access: { allowAll: true }\n';

/** `name=value` pairs from Set-Cookie headers, for sending back in a Cookie header. */
export function cookiesFrom(header: string | string[] | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const line of [header ?? []].flat()) {
    const [pair = ''] = line.split(';');
    const eq = pair.indexOf('=');
    cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return cookies;
}

export const cookieHeader = (cookies: Map<string, string>) =>
  [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

/** One request at the IdP with the browser's IdP cookies; returns the redirect, if any. */
export async function idpRequest(jar: Map<string, string>, url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { ...(init.headers as Record<string, string>), cookie: cookieHeader(jar) },
  });
  for (const [k, v] of cookiesFrom(res.headers.getSetCookie())) jar.set(k, v);
  const location = res.headers.get('location');
  return { res, location: location ? new URL(location, url).href : undefined };
}

/**
 * Plays the browser at the IdP: open the login page, pick the user, follow back to Warden.
 * Pass `jar` to keep the IdP's cookies (its session) across calls.
 */
export async function signInAtIdp(
  authorizeUrl: string,
  sub: string,
  jar = new Map<string, string>(),
): Promise<URL> {
  const go = async (url: string, init: RequestInit = {}) =>
    (await idpRequest(jar, url, init)).location;

  const interaction = await go(authorizeUrl);
  expect(interaction).toBeDefined();
  const resume = await go(`${interaction}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: sub }).toString(),
  });
  expect(resume).toBeDefined();
  const callback = await go(resume!);
  expect(callback).toBeDefined();
  return new URL(callback!);
}

/** Start a login at Warden; returns the IdP URL and the login cookie Warden set. */
export async function beginLogin(app: FastifyInstance, returnTo?: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/login',
    ...(returnTo !== undefined ? { query: { returnTo } } : {}),
  });
  expect(res.statusCode).toBe(302);
  return {
    authorizeUrl: String(res.headers.location),
    cookies: cookiesFrom(res.headers['set-cookie']),
  };
}

export function callback(
  app: FastifyInstance,
  url: URL,
  cookies: Map<string, string>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { cookie: cookieHeader(cookies) },
  });
}

/** Log in as a mock user through the real OIDC flow; returns a Cookie header for requests. */
export async function login(app: FastifyInstance, sub = 'admin'): Promise<string> {
  const { authorizeUrl, cookies } = await beginLogin(app);
  const res = await callback(app, await signInAtIdp(authorizeUrl, sub), cookies);
  expect(res.statusCode).toBe(302);
  const session = [...cookiesFrom(res.headers['set-cookie'])].find(
    ([k, v]) => k.includes('warden_session') && v,
  );
  expect(session).toBeDefined();
  return `${session![0]}=${session![1]}`;
}

/**
 * Plays the browser at the IdP's end-session endpoint: confirms the logout (which the mock's
 * page does by script) and returns where the IdP redirects back to.
 */
export async function logoutAtIdp(logoutUrl: string, jar: Map<string, string>) {
  const { res } = await idpRequest(jar, logoutUrl);
  expect(res.status).toBe(200);
  const html = await res.text();
  const action = /action="([^"]+)"/.exec(html)?.[1];
  const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
  expect(action && xsrf).toBeTruthy();
  const { location } = await idpRequest(jar, new URL(action!, logoutUrl).href, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ xsrf: xsrf!, logout: 'yes' }).toString(),
  });
  return location;
}
