import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import fastifyStatic from '@fastify/static';
import type { EffectiveSchema, Policy } from '@wardenhq/core';
import type { Database } from '@wardenhq/pg-adapter';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAuth, type AuthOptions } from './routes/auth.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerPolicy } from './routes/policy.js';
import { registerRoleRoutes, type RoleRoutesOptions } from './routes/roles.js';
import { registerSavedViewRoutes } from './routes/saved-views.js';
import { registerSchemaDriftRoutes, type SchemaDriftOptions } from './routes/schema-drift.js';
import { createViews } from './views.js';

export interface AppOptions {
  /** Effective schema to serve. Already narrowed by config, so it is safe to send as-is. */
  schema?: EffectiveSchema;
  /** Data connection; entity routes are registered when both `schema` and `db` are given. */
  db?: Database;
  /** Who may do what; enforced on every entity route. Required whenever data routes are served. */
  policy?: Policy;
  /** Login routes and the session check on /api. Required whenever data routes are served. */
  auth?: AuthOptions;
  /** Introspected model and config for the schema drift page; registered when `db` is given. */
  drift?: Omit<SchemaDriftOptions, 'db'>;
  /** Config for the roles page; registered when `db` is given. */
  roles?: Omit<RoleRoutesOptions, 'db'>;
  /** Directory containing the built web UI. Served with SPA fallback when present. */
  webDir?: string;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({
  schema,
  db,
  policy,
  auth,
  drift,
  roles,
  webDir,
  logger = false,
}: AppOptions = {}) {
  if ((schema || drift || roles) && !auth) throw new Error('auth is required to serve /api routes');
  if (schema && db && !policy) throw new Error('policy is required to serve entity routes');
  // Request ids are logged and stored with audit entries, so they must be unique across restarts
  // and replicas.
  const app = Fastify({ logger, genReqId: () => randomUUID() });

  // Don't leak database errors (SQL, constraint names, values) to clients; they are logged.
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ statusCode, error: STATUS_CODES[statusCode] ?? 'Error', message: err.message });
    }
    req.log.error({ err }, 'request failed');
    return reply
      .code(500)
      .send({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  if (auth) await registerAuth(app, auth);
  // Each user gets the schema as their roles see it: fields they can't read are left out.
  const views = schema && policy ? createViews(schema, policy) : undefined;
  if (schema) app.get('/api/schema', async (req) => (views ? views(req.roles).schema : schema));
  if (schema && db && policy && views) {
    registerPolicy(app, schema, policy);
    registerEntityRoutes(app, schema, db, policy, views);
    registerCapabilityRoutes(app, schema, policy);
    registerAuditRoutes(app, { db, policy, views, roles: auth?.roles ?? {} });
    registerSavedViewRoutes(app, { db, policy, views, roles: auth?.roles ?? {} });
  }
  if (drift && db) registerSchemaDriftRoutes(app, { ...drift, db });
  if (roles && db) registerRoleRoutes(app, { ...roles, db });

  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not Found' });
    });
  }

  return app;
}
