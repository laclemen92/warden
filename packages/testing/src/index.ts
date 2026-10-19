import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

/** Keep in sync with the image in docker-compose.yml. */
export const POSTGRES_IMAGE = 'postgres:18-alpine';

export interface TestDatabase {
  connectionString: string;
  /** Run SQL against the database (e.g. to add fixtures in a single test). */
  exec(sql: string): Promise<void>;
  stop(): Promise<void>;
}

export interface StartPostgresOptions {
  /** SQL scripts executed in order once the database is up. */
  sql?: string[];
}

/** Start a disposable Postgres container. Requires a running Docker daemon. */
export async function startPostgres({
  sql = [],
}: StartPostgresOptions = {}): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const connectionString = container.getConnectionUri();

  const exec = async (script: string) => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query(script);
    } finally {
      await client.end();
    }
  };

  for (const script of sql) await exec(script);

  return {
    connectionString,
    exec,
    stop: async () => {
      await container.stop();
    },
  };
}

const examplesDir = new URL('../../../examples/', import.meta.url);

/** Read a SQL file from the repository's `examples/` directory, e.g. `basic/schema.sql`. */
export function readExampleSql(path: string): Promise<string> {
  return readFile(fileURLToPath(new URL(path, examplesDir)), 'utf8');
}
