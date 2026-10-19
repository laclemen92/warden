import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';

export interface AppOptions {
  /** Directory containing the built web UI. Served with SPA fallback when present. */
  webDir?: string;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({ webDir, logger = false }: AppOptions = {}) {
  const app = Fastify({ logger });

  app.get('/healthz', async () => ({ status: 'ok' }));

  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not Found' });
    });
  }

  return app;
}
