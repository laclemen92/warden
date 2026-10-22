import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

/** Keep in sync with the image in docker-compose.yml. */
export const POSTGRES_IMAGE = 'postgres:18-alpine';

/** Set by the `@wardenhq/testing/global-setup` Vitest hook to the shared server's admin URL. */
export const SHARED_POSTGRES_ENV = 'WARDEN_TEST_POSTGRES_URL';

export interface TestDatabase {
  connectionString: string;
  /** Run SQL against the database (e.g. to add fixtures in a single test). */
  exec(sql: string): Promise<void>;
  /**
   * Drop the database once every connection to it has closed. It never terminates a connection:
   * a killed backend sends `57P01` to its client, and a client checked out of a `pg.Pool` has no
   * `error` listener, so that would be an unhandled error in the test. A database still in use
   * after a grace period is left for the global teardown, which stops the container only after
   * every test process has exited.
   */
  stop(): Promise<void>;
}

export interface StartPostgresOptions {
  /** SQL scripts executed in order once the database is up. */
  sql?: string[];
}

/** How long `stop()` waits for the test's own pools to disconnect before giving up on them. */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * A fresh, empty database for one test file.
 *
 * Every file gets its own database on the one Postgres container the package's Vitest
 * `globalSetup` (`@wardenhq/testing/global-setup`) starts. Roles are cluster-wide and outlive the
 * database, so name any role a test creates with `uniqueRoleName()`.
 */
export async function startPostgres({
  sql = [],
}: StartPostgresOptions = {}): Promise<TestDatabase> {
  const shared = process.env[SHARED_POSTGRES_ENV];
  if (!shared) {
    throw new Error(
      `startPostgres() needs a Postgres server: add globalSetup: ['@wardenhq/testing/global-setup'] to this package's vitest.config.ts`,
    );
  }
  const db = await createDatabase(shared);
  const exec = async (script: string) => {
    await withClient(db.connectionString, (c) => c.query(script));
  };
  for (const script of sql) await exec(script);
  return { connectionString: db.connectionString, exec, stop: db.stop };
}

/**
 * `base` plus a random suffix. The shared server outlives a single run of a test file (Vitest watch
 * mode keeps it between reruns), so a fixed role name would already exist the second time.
 */
export function uniqueRoleName(base: string): string {
  return `${base}_${randomBytes(6).toString('hex')}`;
}

/** Start a disposable Postgres container. Requires a running Docker daemon. */
export function startContainer(): Promise<StartedPostgreSqlContainer> {
  // Durability is pointless for throwaway data; skipping fsync makes schema setup much faster.
  return new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand([
      'postgres',
      ...['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
      // Test files run in parallel against one server, each with an app pool or two.
      ...['-c', 'max_connections=500'],
    ])
    .start();
}

async function createDatabase(adminUrl: string) {
  const name = `test_${randomBytes(8).toString('hex')}`;
  await withClient(adminUrl, (c) => c.query(`create database ${name}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    connectionString: url.href,
    stop: async () => {
      if (await drained(adminUrl, name)) {
        await withClient(adminUrl, (c) => c.query(`drop database if exists ${name}`));
      }
    },
  };
}

/** Wait until nothing but ourselves is connected to `database`. */
async function drained(adminUrl: string, database: string): Promise<boolean> {
  return withClient(adminUrl, async (c) => {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    for (;;) {
      const { rows } = await c.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
         where datname = $1 and pid <> pg_backend_pid()`,
        [database],
      );
      if (rows[0]!.n === 0) return true;
      if (Date.now() > deadline) return false;
      await sleep(50);
    }
  });
}

async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  // A connection the server drops must not surface as an unhandled error in the test.
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

const examplesDir = new URL('../../../examples/', import.meta.url);

/** Read a SQL file from the repository's `examples/` directory, e.g. `basic/schema.sql`. */
export function readExampleSql(path: string): Promise<string> {
  return readFile(fileURLToPath(new URL(path, examplesDir)), 'utf8');
}
