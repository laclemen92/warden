import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOidcClient } from '../src/auth/oidc.js';
import { RefreshRejectedError } from '../src/auth/session.js';
import { parseAuthSettings } from '../src/auth/settings.js';
import { PUBLIC_URL } from './helpers/auth.js';

// A bare IdP whose token endpoint answers however the test says, to check how refresh failures
// are classified.
let server: http.Server;
let issuer: string;
let tokenResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
      });
    }
    if (req.url === '/token') {
      req.resume();
      return req.on('end', () => json(tokenResponse.status, tokenResponse.body));
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const client = () =>
  createOidcClient(
    parseAuthSettings({
      WARDEN_PUBLIC_URL: PUBLIC_URL,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'warden',
      OIDC_CLIENT_SECRET: 'test-client-secret',
      OIDC_AUDIENCE: 'https://api.example.com',
      WARDEN_SESSION_SECRET: 'test-session-secret-that-is-long-enough',
    }),
  );

describe('refresh', () => {
  it('returns the new tokens', async () => {
    tokenResponse = {
      status: 200,
      body: { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 300 },
    };
    expect(await client().refresh('old')).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 300,
    });
  });

  it('reports invalid_grant as a rejected refresh token', async () => {
    tokenResponse = { status: 400, body: { error: 'invalid_grant' } };
    const err = await client()
      .refresh('old')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefreshRejectedError);
    expect((err as RefreshRejectedError).code).toBe('invalid_grant');
  });

  it.each([
    [429, 'too_many_requests'],
    [401, 'invalid_client'],
    [400, 'invalid_request'],
    [503, 'temporarily_unavailable'],
  ])('treats %i %s as transient, so the refresh token is kept', async (status, error) => {
    tokenResponse = { status, body: { error } };
    const err = await client()
      .refresh('old')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RefreshRejectedError);
  });
});
