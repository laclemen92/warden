import { describe, expect, it } from 'vitest';
import {
  apiBodyMessage,
  checkActionDefinitions,
  checkActionUrl,
  cleanApiMessage,
} from '../src/index.js';

const hmac = { type: 'hmac', secretEnv: 'API_SECRET' };
const httpAction = (http: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
  checkActionDefinitions([
    {
      name: 'review',
      label: 'Review',
      on: 'users',
      http: { url: 'https://api.example.com/review', auth: hmac, ...http },
      ...overrides,
    },
  ]);

describe('HTTP action definitions', () => {
  it('defaults to confirm, POST, no permissions and a 10 s timeout', () => {
    const result = httpAction();
    expect(result.ok && result.specs[0]).toMatchObject({
      confirm: 'confirm',
      permissions: {},
      requireReason: true,
      http: {
        method: 'POST',
        url: 'https://api.example.com/review',
        auth: hmac,
        timeoutMs: 10_000,
        perRecord: false,
        concurrency: 4,
      },
    });
  });

  it('keeps a function url off the spec', () => {
    const result = httpAction({ url: () => 'https://api.example.com' });
    expect(result.ok && result.specs[0]!.http!.url).toBeUndefined();
  });

  it('reports every problem', () => {
    const result = httpAction(
      {
        url: 42,
        method: 'GET',
        body: {},
        timeoutMs: 120_000,
        perRecord: true,
        concurrency: 0,
        extra: true,
        auth: { type: 'client_credentials', tokenUrl: '', clientIdEnv: 'bad name' },
      },
      { run: async () => {}, confirm: 'preview', permissions: { users: ['update'] } },
    );
    expect(result.ok ? [] : result.errors).toEqual([
      'action "review": give either run or http, not both',
      'action "review": http actions can\'t be previewed; leave confirm out',
      'action "review": http actions write nothing through tx, so they take no permissions',
      'action "review": http.extra is not a known key',
      'action "review": http.url must be a string or a function',
      'action "review": http.method must be POST, PUT, PATCH or DELETE',
      'action "review": http.body must be a function',
      'action "review": http.timeoutMs must be a positive integer of at most 60000',
      'action "review": http.perRecord needs target "many"',
      'action "review": http.concurrency must be a positive integer of at most 16',
      'action "review": http.auth.tokenUrl must be a non-empty string',
      'action "review": http.auth.clientIdEnv must be an environment variable name',
      'action "review": http.auth.clientSecretEnv must be an environment variable name',
      'action "review": http.auth.secretEnv must be an environment variable name',
    ]);
  });

  it('requires auth, and only the keys its type takes', () => {
    expect(httpAction({ auth: undefined })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/http.auth is required/)],
    });
    expect(httpAction({ auth: { type: 'user', audience: 'x', secretEnv: 'Y' } })).toMatchObject({
      ok: false,
      errors: ['action "review": http.auth.secretEnv is not a known key for type "user"'],
    });
    expect(httpAction({ auth: { type: 'token' } }).ok).toBe(false);
  });

  it('still requires run without http', () => {
    const result = checkActionDefinitions([
      { name: 'x', label: 'X', on: 'users', permissions: {} },
    ]);
    expect(result).toMatchObject({ ok: false, errors: ['action "x": run must be a function'] });
  });
});

describe('checkActionUrl', () => {
  it('allows https, and http only on loopback or when allowed', () => {
    expect(checkActionUrl('https://api.example.com/x', false)).toBeUndefined();
    for (const url of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'http://[::1]:80/x']) {
      expect(checkActionUrl(url, false)).toBeUndefined();
    }
    expect(checkActionUrl('http://api.example.com/x', false)).toMatch(/must use https/);
    expect(checkActionUrl('http://127.0.0.1.example.com/x', false)).toMatch(/must use https/);
    expect(checkActionUrl('http://api.example.com/x', true)).toBeUndefined();
    expect(checkActionUrl('ftp://api.example.com/x', true)).toBe('must use https');
    expect(checkActionUrl('not a url', true)).toBe('is not a valid URL');
  });
});

describe('cleanApiMessage', () => {
  it('strips markup and control characters, and caps the length', () => {
    expect(cleanApiMessage('<p>Already\u0000 <b>resolved</b></p>\n')).toBe('Already resolved');
    expect(cleanApiMessage('<br>')).toBeUndefined();
    expect(cleanApiMessage(42)).toBeUndefined();
    const long = cleanApiMessage('x'.repeat(1000))!;
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });

  it('finds the message in common error bodies', () => {
    expect(apiBodyMessage({ message: ['first', 'second'] })).toBe('first');
    expect(apiBodyMessage({ error: 'Not found' })).toBe('Not found');
    expect(apiBodyMessage({ error: { code: 1 } })).toBeUndefined();
    expect(apiBodyMessage('plain text')).toBe('plain text');
  });
});
