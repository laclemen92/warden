import { loadConfig, requireAccess } from '@wardenhq/config';
import { resolvePolicy, resolveSchema } from '@wardenhq/core';
import {
  assignedRoles,
  createDatabase,
  ensureSchemaSnapshot,
  introspect,
  migrate,
  pendingMigrations,
} from '@wardenhq/pg-adapter';
import { buildApp, type AppOptions } from './app.js';
import { createOidcClient } from './auth/oidc.js';
import { createSessions } from './auth/session.js';
import { parseAuthSettings } from './auth/settings.js';

export interface WardenOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  webDir?: string;
  logger?: AppOptions['logger'];
}

/** `WARDEN_MIGRATE`: on by default; off when a separate, privileged role runs migrations. */
export function parseMigrateFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() || 'true';
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error('WARDEN_MIGRATE must be true or false');
}

/**
 * Load config, migrate Warden's own schema (or check it is current), introspect the database, and build the app. Config that doesn't match the
 * database is logged as warnings; invalid config, or config without `access`, throws a ConfigError.
 */
export async function createWarden({
  env = process.env,
  cwd = process.cwd(),
  webDir,
  logger = false,
}: WardenOptions = {}) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const authSettings = parseAuthSettings(env);
  const runMigrations = parseMigrateFlag(env.WARDEN_MIGRATE);

  const loaded = await loadConfig({ cwd, env });
  requireAccess(loaded);
  const { config, path: configPath } = loaded;
  // Route idle-connection errors to the app logger once it exists.
  let logIdleError = (err: Error) => console.error('idle database connection error', err);
  const { pool, db, close } = createDatabase({
    connectionString,
    onIdleError: (err) => logIdleError(err),
  });

  try {
    let migrations: string[] = [];
    if (runMigrations) {
      migrations = await migrate(db);
    } else {
      const pending = await pendingMigrations(db);
      if (pending.length > 0) {
        throw new Error(
          `WARDEN_MIGRATE is off but the warden schema is missing migrations: ${pending.join(', ')}. ` +
            'Run `node dist/migrate.js` as the schema owner first.',
        );
      }
    }
    const model = await introspect(pool, { schemas: config.schemas });
    const { schema, warnings: schemaWarnings } = resolveSchema(model, config);
    const { policy, warnings: policyWarnings } = resolvePolicy(schema, config);
    const warnings = [...schemaWarnings, ...policyWarnings];
    // The first start records the schema drift baseline.
    await ensureSchemaSnapshot(db, model);

    const auth = {
      sessionSecret: authSettings.sessionSecret,
      sessions: createSessions(db, authSettings),
      oidc: createOidcClient(authSettings),
      ...(config.access ? { access: config.access } : {}),
      roles: config.roles,
      assignedRoles: (email: string) => assignedRoles(db, email),
    };
    const app = await buildApp({
      schema,
      db,
      policy,
      auth,
      drift: { model, config },
      roles: {
        config,
        sessionTimeouts: {
          idleSeconds: authSettings.idleTimeoutSeconds,
          absoluteSeconds: authSettings.absoluteTimeoutSeconds,
        },
      },
      logger,
      ...(webDir ? { webDir } : {}),
    });
    app.addHook('onClose', close);
    logIdleError = (err) => app.log.error({ err }, 'idle database connection error');

    if (migrations.length > 0) app.log.info({ migrations }, 'applied migrations');
    app.log.info(
      { config: configPath ?? '(defaults)', entities: schema.entities.length },
      'schema loaded',
    );
    if (config.access?.allowAll) {
      app.log.warn(
        'access.allowAll is on: everyone the identity provider authenticates can sign in and read per defaults.read',
      );
    }
    for (const warning of warnings) {
      app.log.warn({ configPath: warning.path }, `config: ${warning.message}`);
    }
    return app;
  } catch (err) {
    await close();
    throw err;
  }
}
