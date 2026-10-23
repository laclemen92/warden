import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIT_BODY_BYTES,
  apiBodyMessage,
  auditedBody,
  checkActionDefinitions,
  checkActionUrl,
  cleanApiMessage,
  redactJson,
  stepsProgress,
  type HttpStepSpec,
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

const stepsAction = (http: Record<string, unknown>) =>
  checkActionDefinitions([
    { name: 'chain', label: 'Chain', on: 'users', http: { auth: hmac, ...http } },
  ]);
const errorsOf = (http: Record<string, unknown>) => {
  const result = stepsAction(http);
  return result.ok ? [] : result.errors;
};

describe('multi-step HTTP action definitions', () => {
  it('checks each step and fills in defaults', () => {
    const result = stepsAction({
      timeoutMs: 2000,
      steps: [
        { name: 'payout', url: 'https://api.example.com/p', auditBody: { redact: ['token'] } },
        {
          name: 'claim',
          url: () => 'https://api.example.com/c',
          method: 'PUT',
          when: () => true,
          timeoutMs: 500,
          compensate: { url: () => 'https://api.example.com/undo' },
        },
      ],
    });
    expect(result.ok && result.specs[0]!.http).toEqual({
      method: 'POST',
      auth: hmac,
      timeoutMs: 2000,
      perRecord: false,
      concurrency: 1,
      steps: [
        {
          name: 'payout',
          method: 'POST',
          url: 'https://api.example.com/p',
          timeoutMs: 2000,
          conditional: false,
          auditBody: { redact: ['token'] },
        },
        {
          name: 'claim',
          method: 'PUT',
          timeoutMs: 500,
          conditional: true,
          compensate: { method: 'POST', timeoutMs: 500 },
        },
      ],
    });
  });

  it('refuses bad steps', () => {
    const url = 'https://api.example.com';
    const at = (message: string) => `action "chain": http.${message}`;
    expect(errorsOf({ steps: [] })).toEqual([at('steps must be a non-empty array')]);
    expect(errorsOf({ url, steps: [{ name: 'a', url }] })).toEqual([
      at("url can't be used with steps; set it on each step"),
    ]);
    expect(
      errorsOf({
        steps: [
          { name: 'a', url },
          { name: 'a', url },
        ],
      }),
    ).toEqual([at('steps[1].name "a" repeats an earlier step')]);
    expect(errorsOf({ steps: [{ name: 'Bad-name', url }] })[0]).toMatch(
      /steps\[0\]\.name must match/,
    );
    expect(errorsOf({ steps: [{ name: 'a' }] })).toEqual([
      at('steps[0].url must be a string or a function'),
    ]);
    expect(errorsOf({ steps: [{ name: 'a', url, when: true }] })).toEqual([
      at('steps[0].when must be a function'),
    ]);
    expect(errorsOf({ steps: [{ name: 'a', url, retries: 3 }] })).toEqual([
      at('steps[0].retries is not a known key'),
    ]);
    expect(errorsOf({ steps: [{ name: 'a', url, compensate: {} }] })).toEqual([
      at('steps[0].compensate.url must be a string or a function'),
    ]);
    expect(errorsOf({ steps: [{ name: 'a', url, auditBody: { redact: 'token' } }] })).toEqual([
      at('steps[0].auditBody must be true or { redact: [key, ...] }'),
    ]);
    expect(errorsOf({ steps: [{ name: 'a', url, timeoutMs: 120_000 }] })).toEqual([
      at('steps[0].timeoutMs must be a positive integer of at most 60000'),
    ]);
  });
});

describe('step response bodies in the audit log', () => {
  it('redacts keys at any depth, ignoring case', () => {
    expect(
      redactJson({ Token: 'x', nested: [{ token: 'y', keep: 1 }], ok: true }, ['token']),
    ).toEqual({ Token: '[redacted]', nested: [{ token: '[redacted]', keep: 1 }], ok: true });
  });

  it('leaves out a body too large to keep', () => {
    expect(auditedBody({ a: 1 }, [])).toEqual({ body: { a: 1 } });
    expect(auditedBody({ a: 'x'.repeat(MAX_AUDIT_BODY_BYTES) }, [])).toEqual({
      bodyOmitted: true,
    });
  });
});

describe('stepsProgress', () => {
  const steps = ['a', 'b', 'c'].map((name): HttpStepSpec => ({
    name,
    method: 'POST',
    timeoutMs: 1000,
    conditional: false,
  }));

  it('collects the steps done across tries', () => {
    const progress = stepsProgress(steps, [
      {
        attempt: '1',
        result: 'partial',
        steps: [
          { name: 'a', result: 'ok', status: 201, body: { id: 1 } },
          { name: 'b', result: 'failed', status: 502 },
          { name: 'c', result: 'not_attempted' },
        ],
      },
      {
        attempt: '1',
        result: 'partial',
        steps: [
          { name: 'a', result: 'ok', earlier: true },
          { name: 'b', result: 'skipped' },
          { name: 'c', result: 'rejected', status: 409 },
        ],
      },
    ]);
    expect([...progress.done]).toEqual([
      ['a', { result: 'ok', status: 201, body: { id: 1 }, kept: true }],
      ['b', { result: 'skipped', kept: false }],
    ]);
    expect(progress).toMatchObject({ compensated: false, finished: false });
  });

  it('notices undo calls and a finished chain', () => {
    const undone = stepsProgress(steps, [
      {
        attempt: '1',
        result: 'partial',
        steps: [
          { name: 'a', result: 'ok', compensation: { result: 'failed' } },
          { name: 'b', result: 'failed' },
        ],
      },
    ]);
    expect(undone.compensated).toBe(true);
    const finished = stepsProgress(steps, [
      {
        attempt: '1',
        result: 'ok',
        steps: steps.map((s) => ({ name: s.name, result: 'ok' as const })),
      },
    ]);
    expect(finished.finished).toBe(true);
  });
});
