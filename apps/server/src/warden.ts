import { loadConfig } from '@wardenhq/config';
import { resolveSchema } from '@wardenhq/core';
import { createDatabase, introspect, migrate } from '@wardenhq/pg-adapter';
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

/**
 * Load config, migrate Warden's own schema, introspect the database, and build the app. Config that doesn't match the
 * database is logged as warnings; invalid config throws a ConfigError.
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

  const { config, path: configPath } = await loadConfig({ cwd, env });
  // Route idle-connection errors to the app logger once it exists.
  let logIdleError = (err: Error) => console.error('idle database connection error', err);
  const { pool, db, close } = createDatabase({
    connectionString,
    onIdleError: (err) => logIdleError(err),
  });

  try {
    const migrations = await migrate(db);
    const model = await introspect(pool, { schemas: config.schemas });
    const { schema, warnings } = resolveSchema(model, config);

    const auth = {
      sessionSecret: authSettings.sessionSecret,
      sessions: createSessions(db, authSettings),
      oidc: createOidcClient(authSettings),
      ...(config.access ? { access: config.access } : {}),
    };
    const app = await buildApp({ schema, db, auth, logger, ...(webDir ? { webDir } : {}) });
    app.addHook('onClose', close);
    logIdleError = (err) => app.log.error({ err }, 'idle database connection error');

    if (migrations.length > 0) app.log.info({ migrations }, 'applied migrations');
    app.log.info(
      { config: configPath ?? '(defaults)', entities: schema.entities.length },
      'schema loaded',
    );
    for (const warning of warnings) {
      app.log.warn({ configPath: warning.path }, `config: ${warning.message}`);
    }
    return app;
  } catch (err) {
    await close();
    throw err;
  }
}
