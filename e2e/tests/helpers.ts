import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Users of the compose mock IdP (packages/mock-oidc) and the roles the example config gives them. */
export const USERS = {
  viewer: 'viewer@example.com',
  editor: 'editor@example.com',
  admin: 'admin@example.com',
} as const;

/** Sign in through the real flow: Warden's login page, the mock IdP, and back. */
export async function signIn(page: Page, user: keyof typeof USERS) {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with SSO' }).click();
  await page.getByRole('button', { name: USERS[user] }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('navigation', { name: 'Entities' })).toBeVisible();
}

export interface RecordItem {
  id: string;
  version: string;
  values: Record<string, unknown>;
}

/** The first user record, read through the API as the signed-in user. */
export async function firstUser(request: APIRequestContext): Promise<RecordItem> {
  const res = await request.get('/api/entities/users?limit=1&sort=id');
  expect(res.status()).toBe(200);
  const { items } = (await res.json()) as { items: RecordItem[] };
  expect(items[0]).toBeDefined();
  return items[0]!;
}

/**
 * Open `path` and wait until the UI knows what the user may do, so a missing control means it
 * is hidden rather than not yet rendered.
 */
export async function openWithCapabilities(page: Page, path: string) {
  const capabilities = page.waitForResponse(
    (res) => new URL(res.url()).pathname === '/api/capabilities' && res.ok(),
  );
  await page.goto(path);
  await capabilities;
}
