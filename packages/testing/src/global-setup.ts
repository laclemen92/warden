import { SHARED_POSTGRES_ENV, startContainer } from './index.js';

/**
 * Vitest `globalSetup`: one Postgres container for the whole run. `startPostgres()` then gives each
 * test file its own database on it. Workers inherit the URL through the environment.
 *
 * Teardown runs after every worker has exited, so stopping the container can't kill a connection
 * a test still holds.
 */
export async function setup(): Promise<() => Promise<void>> {
  const container = await startContainer();
  process.env[SHARED_POSTGRES_ENV] = container.getConnectionUri();
  return async () => {
    delete process.env[SHARED_POSTGRES_ENV];
    await container.stop();
  };
}
