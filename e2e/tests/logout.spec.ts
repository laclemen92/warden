import { expect, test } from '@playwright/test';
import { signIn, USERS } from './helpers.js';

test('logging out ends the IdP session too', async ({ page }) => {
  await signIn(page, 'viewer');
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();

  // The IdP signs the user out and sends the browser back to Warden, which asks them to sign in.
  await expect(page.getByRole('link', { name: 'Continue with SSO' })).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);

  // The IdP asks who to sign in as again instead of silently reusing the previous user.
  await page.getByRole('link', { name: 'Continue with SSO' }).click();
  await expect(page.getByRole('button', { name: USERS.viewer })).toBeVisible();
});
