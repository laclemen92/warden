import { describe, expect, it } from 'vitest';
import { loginPath, safeReturnTo, ssoLoginUrl } from '../src/lib/auth';

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
