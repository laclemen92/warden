import { defineConfig, devices } from '@playwright/test';

// The stack is started separately with `docker compose up --build --wait` (see README), so the
// suite runs against the same image and mock IdP that ship in compose.
const baseURL = process.env.WARDEN_URL ?? `http://localhost:${process.env.WARDEN_PORT ?? 3000}`;

export default defineConfig({
  testDir: 'tests',
  // Tests sign in as different users and write to the shared example database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
