import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditWriteError } from '@wardenhq/pg-adapter';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('server', () => {
  it('responds to health checks', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports the release version from /healthz', async () => {
    const app = await buildApp({ version: '1.2.3-rc.1' });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok', version: '1.2.3-rc.1' });
  });

  it('serves index.html for client routes but 404s unknown API routes', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'warden-web-'));
    writeFileSync(join(webDir, 'index.html'), '<div id="root"></div>');
    const app = await buildApp({ webDir });

    const page = await app.inject({ method: 'GET', url: '/entities/users' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('root');

    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
  });

  it('answers data errors with a generic 400, and other database errors with a generic 500', async () => {
    const app = await buildApp();
    const pgError = (code: string) =>
      Object.assign(new Error('value "secret" is invalid'), { code });
    app.get('/api/data-error', async () => {
      throw pgError('22026');
    });
    app.get('/api/audit-data-error', async () => {
      throw new AuditWriteError(pgError('22021'));
    });
    app.get('/api/other-error', async () => {
      throw pgError('42P01');
    });

    for (const url of ['/api/data-error', '/api/audit-data-error']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'a value is invalid',
      });
    }
    const res = await app.inject({ method: 'GET', url: '/api/other-error' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
  });
});
