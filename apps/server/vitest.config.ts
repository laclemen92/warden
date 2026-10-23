import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One Postgres container for the package; startPostgres() gives each test file a database on it.
    globalSetup: ['@wardenhq/testing/global-setup'],
  },
});
