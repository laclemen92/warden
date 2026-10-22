import { loadConfig, requireAccess } from '@wardenhq/config';
import {
  deleteCascadeWarnings,
  resolveActionPolicy,
  resolvePolicy,
  resolveSchema,
  sessionEmail,
} from '@wardenhq/core';
import {
  assignedRoles,
  canDisableAuditTriggers,
  createDatabase,
  ensureSchemaSnapshot,
  introspect,
  migrate,
  pendingMigrations,
  refreshSessionEmails,
  startDetachedTransaction,
} from '@wardenhq/pg-adapter';
import { ActionsError, loadActions } from './actions.js';
import { buildApp, type AppOptions } from './app.js';
import { createOidcClient } from './auth/oidc.js';
import { createSessions } from './auth/session.js';
import { parseAuthSettings, parseDuration } from './auth/settings.js';
import type { ActionLimits } from './routes/actions.js';
import type { ExportLimits } from './routes/export.js';

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

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2 };

/** `WARDEN_BODY_LIMIT`: largest request body in bytes, `kb`, or `mb`; 1mb by default. */
export function parseBodyLimit(value: string | undefined): number {
  const match = /^(\d+)\s*(b|kb|mb)?$/.exec(value?.trim().toLowerCase() || '1mb');
  const bytes = match ? Number(match[1]) * SIZE_UNITS[match[2] ?? 'b']! : 0;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('WARDEN_BODY_LIMIT must be a size like 512kb or 2mb');
  }
  return bytes;
}

export interface DatabaseSettings {
  idleInTransactionTimeoutMs: number;
  exports: ExportLimits;
  actions: ActionLimits;
}

/**
 * Database timeouts and export and action limits from the environment. Throws one error listing every
 * problem.
 */
export function parseDatabaseSettings(env: Record<string, string | undefined>): DatabaseSettings {
  const problems: string[] = [];
  const duration = (name: string, fallback: string) => {
    const seconds = parseDuration(env[name] ?? fallback);
    if (seconds === undefined) problems.push(`${name} must be a duration like 30s, 5m, or 1h`);
    return (seconds ?? 0) * 1000;
  };
  const count = (name: string, fallback: number) => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    const n = /^\d+$/.test(value) ? Number(value) : 0;
    if (n < 1 || n > 100) problems.push(`${name} must be a whole number from 1 to 100`);
    return n;
  };
  const idleInTransactionTimeoutMs = duration('WARDEN_DB_IDLE_IN_TRANSACTION_TIMEOUT', '60s');
  const exports: ExportLimits = {
    maxConcurrent: count('WARDEN_EXPORT_MAX_CONCURRENT', 4),
    maxPerUser: count('WARDEN_EXPORT_MAX_PER_USER', 2),
    idleTimeoutMs: duration('WARDEN_EXPORT_IDLE_TIMEOUT', '30s'),
    deadlineMs: duration('WARDEN_EXPORT_DEADLINE', '15m'),
  };
  const actions: ActionLimits = {
    maxConcurrent: count('WARDEN_ACTION_MAX_CONCURRENT', 4),
    maxPerUser: count('WARDEN_ACTION_MAX_PER_USER', 2),
    deadlineMs: duration('WARDEN_ACTION_DEADLINE', '60s'),
  };
  // Otherwise Postgres kills a stalled export's connection before Warden ends it cleanly.
  if (exports.idleTimeoutMs >= idleInTransactionTimeoutMs) {
    problems.push(
      'WARDEN_EXPORT_IDLE_TIMEOUT must be shorter than WARDEN_DB_IDLE_IN_TRANSACTION_TIMEOUT',
    );
  }
  if (problems.length > 0) {
    throw new Error(`Invalid database settings:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return { idleInTransactionTimeoutMs, exports, actions };
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
  const bodyLimit = parseBodyLimit(env.WARDEN_BODY_LIMIT);
  const dbSettings = parseDatabaseSettings(env);
  const version = env.WARDEN_VERSION?.trim() || 'dev';

  const loaded = await loadConfig({ cwd, env });
  requireAccess(loaded);
  const { config, path: configPath } = loaded;
  // Route idle-connection errors to the app logger once it exists.
  let logIdleError = (err: Error) => console.error('idle database connection error', err);
  const {
    pool,
    db,
    close: closeMain,
  } = createDatabase({
    connectionString,
    idleInTransactionTimeoutMs: dbSettings.idleInTransactionTimeoutMs,
    onIdleError: (err) => logIdleError(err),
  });
  // Exports get their own pool, sized to how many may run at once, so however many are open (or
  // stalled) the main pool stays free for sessions and every other request.
  const exportDb = createDatabase({
    connectionString,
    idleInTransactionTimeoutMs: dbSettings.idleInTransactionTimeoutMs,
    maxConnections: dbSettings.exports.maxConcurrent,
    onIdleError: (err) => logIdleError(err),
  });
  // Actions too, so runs that hang (on a webhook, say) or pile up can't starve the main pool.
  // Each holds its connection for its whole run, and never more run at once than it has.
  const actionDb = createDatabase({
    connectionString,
    idleInTransactionTimeoutMs: dbSettings.idleInTransactionTimeoutMs,
    maxConnections: dbSettings.actions.maxConcurrent,
    connectionTimeoutMs: 10_000,
    onIdleError: (err) => logIdleError(err),
  });
  const close = async () => {
    await Promise.all([closeMain(), exportDb.close(), actionDb.close()]);
  };

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
    const auditTamperable = await canDisableAuditTriggers(db);
    // Sessions store the email sign-in gave them; config may have changed the rule since.
    await refreshSessionEmails(db, (claims) => sessionEmail(config.access, claims));
    const model = await introspect(pool, { schemas: config.schemas });
    const { schema, warnings: schemaWarnings } = resolveSchema(model, config);
    const { policy, warnings: policyWarnings } = resolvePolicy(schema, config);
    // Loaded after config and the schema, so its tables can be checked, and before routes.
    // Without a module there are no actions, and config granting some only warns.
    const loadedActions = env.WARDEN_ACTIONS ? await loadActions(env.WARDEN_ACTIONS, cwd) : [];
    const {
      actionPolicy,
      warnings: actionWarnings,
      errors: actionErrors,
    } = resolveActionPolicy(
      loadedActions.map((a) => a.spec),
      schema,
      policy,
      config,
    );
    if (actionErrors.length > 0) throw new ActionsError(env.WARDEN_ACTIONS!, actionErrors);
    const actions = {
      actionPolicy,
      definitions: new Map(loadedActions.map((a) => [a.spec.name, a.definition])),
      defaultSchema: config.schemas[0] ?? 'public',
      startTransaction: () => startDetachedTransaction(actionDb.pool),
      limits: dbSettings.actions,
    };
    const actionDeletes = new Set(
      [...actionPolicy.actions.values()].flatMap((a) =>
        Object.entries(a.permissions)
          .filter(([, writes]) => writes.includes('delete'))
          .map(([key]) => key),
      ),
    );
    const warnings = [
      ...schemaWarnings,
      ...policyWarnings,
      ...actionWarnings,
      ...deleteCascadeWarnings(model, schema, policy, actionDeletes),
    ];
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
      actions,
      auth,
      drift: { model, config },
      roles: {
        config,
        sessionTimeouts: {
          idleSeconds: authSettings.idleTimeoutSeconds,
          absoluteSeconds: authSettings.absoluteTimeoutSeconds,
        },
      },
      exports: { exportDb: exportDb.db, limits: dbSettings.exports },
      bodyLimit,
      version,
      logger,
      ...(webDir ? { webDir } : {}),
    });
    app.addHook('onClose', close);
    logIdleError = (err) => app.log.error({ err }, 'idle database connection error');

    app.log.info({ version }, 'starting warden');
    if (migrations.length > 0) app.log.info({ migrations }, 'applied migrations');
    app.log.info(
      {
        config: configPath ?? '(defaults)',
        entities: schema.entities.length,
        actions: actionPolicy.actions.size,
      },
      'schema loaded',
    );
    if (auditTamperable) {
      app.log.warn(
        'the database role Warden runs as owns warden.audit_log, the warden schema, or the audit trigger function (or is a superuser), so it could disable the append-only triggers; run Warden as a separate role (see docs/database.md)',
      );
    }
    if (config.defaults.requireReason.length > 0) {
      app.log.info(
        { requireReason: config.defaults.requireReason },
        'writes without a reason (internal note) get a 400; set defaults.requireReason: [] to make reasons optional',
      );
    }
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
