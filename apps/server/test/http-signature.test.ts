import { describe, expect, it } from 'vitest';
import {
  WardenSignatureError,
  verifyWardenRequest,
} from '../../../docs/examples/verify-warden-request.mjs';
import { HEADERS, parseAllowHttp, signRequest } from '../src/http-actions.js';

const SECRET = 'shared-secret';
const HOST = 'api.example.com';
const KEY = '0b7c6a52-2f1e-4d55-9a43-7c1d2e3f4a5b.payout';
const context = Buffer.from(
  JSON.stringify({
    action: 'review-payout',
    auditId: '42',
    requestId: 'req-1',
    actor: { subject: 'u1', email: 'u1@example.com', roles: ['ops'] },
    reason: 'customer called',
    records: ['7'],
  }),
).toString('base64url');

function signed({
  body = '{"decision":"fraudulent"}',
  path = '/internal/payout-items/7/review',
  timestamp = String(Math.floor(Date.now() / 1000)),
  secret = SECRET,
  host = HOST,
} = {}) {
  return {
    method: 'POST',
    path,
    rawBody: body,
    headers: {
      [HEADERS.context]: context,
      [HEADERS.timestamp]: timestamp,
      [HEADERS.idempotencyKey]: KEY,
      [HEADERS.signature]: signRequest(secret, {
        method: 'POST',
        host,
        path,
        timestamp,
        idempotencyKey: KEY,
        context,
        body,
      }),
    } as Record<string, string>,
  };
}

const verify =
  (request: ReturnType<typeof signed>, options: object = {}) =>
  () =>
    verifyWardenRequest({ secret: SECRET, host: HOST, ...request, ...options });

describe('reference HMAC verifier', () => {
  it('accepts what Warden signs and returns the context', () => {
    expect(verify(signed())()).toMatchObject({
      action: 'review-payout',
      actor: { subject: 'u1' },
      records: ['7'],
    });
    // A Buffer body, as Express's `verify` hook gives it.
    const request = signed();
    expect(verify({ ...request, rawBody: Buffer.from(request.rawBody) as never })()).toBeTruthy();
  });

  it('rejects a tampered body', () => {
    const request = signed();
    expect(verify({ ...request, rawBody: '{"decision":"not_fraudulent"}' })).toThrow(
      WardenSignatureError,
    );
  });

  it('rejects a different path, method or context', () => {
    expect(verify({ ...signed(), path: '/internal/payout-items/8/review' })).toThrow(
      'signature does not match',
    );
    expect(verify({ ...signed(), method: 'DELETE' })).toThrow('signature does not match');
    const request = signed();
    const forged = Buffer.from(JSON.stringify({ actor: { subject: 'admin' } })).toString(
      'base64url',
    );
    expect(
      verify({ ...request, headers: { ...request.headers, [HEADERS.context]: forged } }),
    ).toThrow('signature does not match');
  });

  it('signs with v2', () => {
    expect(signed().headers[HEADERS.signature]).toMatch(/^v2=[0-9a-f]{64}$/);
  });

  it('rejects a request replayed under another Idempotency-Key', () => {
    const request = signed();
    for (const key of [`${KEY}x`, KEY.replace('.payout', '.claim'), '1042']) {
      expect(
        verify({ ...request, headers: { ...request.headers, [HEADERS.idempotencyKey]: key } }),
      ).toThrow('signature does not match');
    }
    const withoutKey = { ...request.headers };
    delete withoutKey[HEADERS.idempotencyKey];
    expect(verify({ ...request, headers: withoutKey })).toThrow('missing Warden signature headers');
  });

  it('rejects a request replayed to another host that shares the secret', () => {
    expect(verify(signed(), { host: 'other-api.example.com' })).toThrow('signature does not match');
    expect(verify(signed(), { host: 'api.example.com:8443' })).toThrow('signature does not match');
    expect(verify(signed({ host: 'evil.example.com' }))).toThrow('signature does not match');
    // Hosts compare case-insensitively, and an API may answer on several.
    expect(verify(signed(), { host: 'API.example.com' })()).toBeTruthy();
    expect(verify(signed(), { host: ['internal.example.com', HOST] })()).toBeTruthy();
    expect(verify(signed(), { host: undefined })).toThrow(/needs the API host/);
  });

  it('rejects a stale or future timestamp', () => {
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(verify(signed({ timestamp: old }))).toThrow('stale or invalid timestamp');
    const future = String(Math.floor(Date.now() / 1000) + 600);
    expect(verify(signed({ timestamp: future }))).toThrow('stale or invalid timestamp');
  });

  it('rejects the wrong secret, and missing headers', () => {
    expect(verify(signed({ secret: 'not-the-secret' }))).toThrow('signature does not match');
    expect(verify({ ...signed(), headers: {} })).toThrow('missing Warden signature headers');
  });
});

describe('parseAllowHttp', () => {
  it('is off by default and rejects nonsense', () => {
    expect(parseAllowHttp(undefined)).toBe(false);
    expect(parseAllowHttp('true')).toBe(true);
    expect(() => parseAllowHttp('maybe')).toThrow(/WARDEN_ACTION_ALLOW_HTTP/);
  });
});
