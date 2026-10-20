import { describe, expect, it } from 'vitest';
import { loginErrorMessage, loginPath, safeReturnTo, ssoLoginUrl } from '../src/lib/auth';

describe('safeReturnTo', () => {
  it('keeps same-origin paths', () => {
    expect(safeReturnTo('/entities/users?x=1')).toBe('/entities/users?x=1');
  });

  it.each([
    null,
    undefined,
    '',
    'entities',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
  ])('rejects %j', (value) => {
    expect(safeReturnTo(value)).toBe('/');
  });
});

describe('loginPath / ssoLoginUrl', () => {
  it('omits returnTo for the home page', () => {
    expect(loginPath('/')).toBe('/login');
  });

  it('encodes the return path', () => {
    expect(loginPath('/entities/users?a=b')).toBe('/login?returnTo=%2Fentities%2Fusers%3Fa%3Db');
    expect(ssoLoginUrl('/entities/users')).toBe('/auth/login?returnTo=%2Fentities%2Fusers');
  });

  it('does not forward an off-site returnTo to the server', () => {
    expect(ssoLoginUrl('//evil.example')).toBe('/auth/login?returnTo=%2F');
  });
});

describe('loginErrorMessage', () => {
  const generic = 'Sign-in failed. Please try again.';

  it('has no message without an error code', () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage(undefined)).toBeNull();
  });

  it('shows the generic message for login_failed', () => {
    expect(loginErrorMessage('login_failed')).toBe(generic);
  });

  it('tells a denied user to ask an administrator, not to retry', () => {
    const message = loginErrorMessage('access_denied');
    expect(message).toMatch(/doesn't have access to Warden.*administrator/);
    expect(message).not.toMatch(/try again/i);
  });

  it.each(['', 'nope', '<img src=x onerror=alert(1)>', '__proto__', 'constructor', 'toString'])(
    'falls back to the generic message for %j',
    (code) => {
      expect(loginErrorMessage(code)).toBe(generic);
    },
  );
});
