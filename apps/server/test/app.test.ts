import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('server', () => {
  it('responds to health checks', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
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
});
