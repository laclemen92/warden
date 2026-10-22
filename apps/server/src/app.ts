import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import fastifyStatic from '@fastify/static';
import type { AnyActionDefinition } from '@wardenhq/actions';
import type { ActionPolicy, AuditStore, EffectiveSchema, Policy } from '@wardenhq/core';
import { AuditUnavailableError, isDataError, type Database } from '@wardenhq/pg-adapter';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { redactingLogger } from './logging.js';
import { registerActionRoutes, type ActionRouteOptions } from './routes/actions.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAuth, type AuthOptions } from './routes/auth.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerExportRoutes, type ExportRouteOptions } from './routes/export.js';
import { registerPolicy } from './routes/policy.js';
import { registerRoleRoutes, type RoleRoutesOptions } from './routes/roles.js';
import { registerSavedViewRoutes, type SavedViewOptions } from './routes/saved-views.js';
import { registerSchemaDriftRoutes, type SchemaDriftOptions } from './routes/schema-drift.js';
import { createViews } from './views.js';

export interface AppOptions {
  /** Effective schema to serve. Already narrowed by config, so it is safe to send as-is. */
  schema?: EffectiveSchema;
  /** Data connection; entity routes are registered when both `schema` and `db` are given. */
  db?: Database;
  /** Who may do what; enforced on every entity route. Required whenever data routes are served. */
  policy?: Policy;
  /** Custom actions from `WARDEN_ACTIONS`; their routes are registered with the data routes. */
  actions?: {
    actionPolicy: ActionPolicy;
    definitions: ReadonlyMap<string, AnyActionDefinition>;
    /** The first configured schema, which unqualified table keys in actions refer to. */
    defaultSchema: string;
  } & Pick<ActionRouteOptions, 'startTransaction' | 'limits'>;
  /** Login routes and the session check on /api. Required whenever data routes are served. */
  auth?: AuthOptions;
  /** Introspected model and config for the schema drift page; registered when `db` is given. */
  drift?: Omit<SchemaDriftOptions, 'db'>;
  /** Config for the roles page; registered when `db` is given. */
  roles?: Omit<RoleRoutesOptions, 'db'>;
  /**
   * Where every audited change is written and History and the audit log read from;
   * `warden.audit_log` when absent.
   */
  audit?: AuditStore;
  /** Export pool and limits; exports use `db` and the default limits when absent. */
  exports?: Pick<ExportRouteOptions, 'exportDb' | 'limits'>;
  /** Directory containing the built web UI. Served with SPA fallback when present. */
  webDir?: string;
  /** Largest request body in bytes; larger ones get a 413. Fastify's default (1 MiB) if unset. */
  bodyLimit?: number;
  /** Release version (`WARDEN_VERSION`, baked into the image); reported by /healthz. */
  version?: string;
  logger?: FastifyServerOptions['logger'];
  /** Config views and `defaults.sharedViews`. */
  savedViews?: Pick<SavedViewOptions, 'configViews' | 'sharedViews'>;
}

export async function buildApp({
  schema,
  db,
  policy,
  actions,
  auth,
  drift,
  roles,
  audit,
  exports,
  webDir,
  bodyLimit,
  version,
  logger = false,
  savedViews,
}: AppOptions = {}) {
  if ((schema || drift || roles) && !auth) throw new Error('auth is required to serve /api routes');
  if (schema && db && !policy) throw new Error('policy is required to serve entity routes');
  // Request ids are logged and stored with audit entries, so they must be unique across restarts
  // and replicas.
  const app = Fastify({
    logger: redactingLogger(logger),
    genReqId: () => randomUUID(),
    ...(bodyLimit !== undefined ? { bodyLimit } : {}),
  });

  // Don't leak database errors (SQL, constraint names, values) to clients; they are logged.
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    // Input is checked before it reaches the database, but a value Postgres still can't accept
    // was the client's, so it's a 400. The message stays generic, since it could echo the value.
    if (isDataError(err)) {
      req.log.warn({ err }, 'request failed with a data error');
      return reply
        .code(400)
        .send({ statusCode: 400, error: 'Bad Request', message: 'a value is invalid' });
    }
    // The message says the audit config is broken, not how; the problems are logged at startup.
    if (err instanceof AuditUnavailableError) {
      req.log.error('request refused: the audit store is misconfigured');
      return reply
        .code(503)
        .send({ statusCode: 503, error: 'Service Unavailable', message: err.message });
    }
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

  app.get('/healthz', async () => ({ status: 'ok', ...(version ? { version } : {}) }));

  if (auth) await registerAuth(app, auth);
  // Each user gets the schema as their roles see it: entities they may do nothing with, and
  // fields they can't read, are left out.
  const views = schema && policy ? createViews(schema, policy) : undefined;
  if (schema) app.get('/api/schema', async (req) => (views ? views(req.roles).schema : schema));
  if (schema && db && policy && views) {
    registerPolicy(app, policy, views);
    registerEntityRoutes(app, schema, db, policy, views, audit);
    registerCapabilityRoutes(app, policy, views, actions?.actionPolicy);
    registerAuditRoutes(app, {
      db,
      policy,
      views,
      roles: auth?.roles ?? {},
      actionPolicy: actions?.actionPolicy,
      audit,
    });
    registerExportRoutes(app, { db, policy, views, ...exports, audit });
    registerSavedViewRoutes(app, { db, policy, views, roles: auth?.roles ?? {}, ...savedViews });
    if (actions && auth) {
      registerActionRoutes(app, {
        ...actions,
        db,
        schema,
        policy,
        views,
        sessionSecret: auth.sessionSecret,
        audit,
      });
    }
  }
  if (drift && db) registerSchemaDriftRoutes(app, { ...drift, db, audit });
  if (roles && db) registerRoleRoutes(app, { ...roles, db, audit });

  const serveWeb = webDir !== undefined && existsSync(webDir);
  if (serveWeb) await app.register(fastifyStatic, { root: webDir });
  // Replaces Fastify's default, which logs and echoes the raw URL, query string and all.
  app.setNotFoundHandler((req, reply) => {
    if (serveWeb && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });
  });

  return app;
}
