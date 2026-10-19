import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { EffectiveSchema } from '@wardenhq/core';
import Fastify, { type FastifyServerOptions } from 'fastify';

export interface AppOptions {
  /** Effective schema to serve. Already narrowed by config, so it is safe to send as-is. */
  schema?: EffectiveSchema;
  /** Directory containing the built web UI. Served with SPA fallback when present. */
  webDir?: string;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({ schema, webDir, logger = false }: AppOptions = {}) {
  const app = Fastify({ logger });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // TODO(#13): require an authenticated session once OIDC login lands.
  if (schema) app.get('/api/schema', async () => schema);

  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not Found' });
    });
  }

  return app;
}
