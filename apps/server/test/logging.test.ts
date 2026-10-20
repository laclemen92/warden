import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/logging.js';

describe('redactUrl', () => {
  it('drops the whole query string of /auth routes', () => {
    expect(redactUrl('/auth/callback?code=abc&state=xyz&iss=https%3A%2F%2Fidp')).toBe(
      '/auth/callback?[redacted]',
    );
    expect(redactUrl('/auth/login?returnTo=%2Fentities')).toBe('/auth/login?[redacted]');
    // The router decodes the path, so these reach the callback too.
    expect(redactUrl('/%61uth/callback?code=abc')).toBe('/%61uth/callback?[redacted]');
    expect(redactUrl('/%E0%A4%A/callback?code=abc')).toBe('/%E0%A4%A/callback?[redacted]');
  });

  it('redacts OIDC parameters on other routes and keeps the rest', () => {
    expect(redactUrl('/?code=abc&state=xyz&page=2')).toBe(
      '/?code=%5Bredacted%5D&state=%5Bredacted%5D&page=2',
    );
    expect(redactUrl('/x?CODE=abc&code=def')).toBe('/x?CODE=%5Bredacted%5D&code=%5Bredacted%5D');
    expect(redactUrl('/x?%63ode=abc')).not.toContain('abc');
  });

  it('leaves URLs without secrets alone', () => {
    expect(redactUrl('/api/entities/users')).toBe('/api/entities/users');
    expect(redactUrl('/api/entities/users?q=ada&sort=-id')).toBe(
      '/api/entities/users?q=ada&sort=-id',
    );
    expect(redactUrl('/auth/callback')).toBe('/auth/callback');
  });
});
