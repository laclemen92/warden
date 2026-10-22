import { expect, test } from '@playwright/test';
import { firstUser, signIn } from './helpers.js';

test('editor edits a user and the change appears in its history', async ({ page }) => {
  await signIn(page, 'editor');
  const user = await firstUser(page.request);
  const before = user.values.full_name === null ? '' : String(user.values.full_name);
  // Unique per run, so the suite can run again against the same database.
  const name = `E2E ${Date.now()}`;
  const reason = `e2e edit ${Date.now()}`;

  await page.goto(`/entities/users/${user.id}`);
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Internal note').fill(reason);
  await page.getByRole('button', { name: 'Save' }).click();

  // Back on the record, with the new value.
  await expect(page).toHaveURL(`/entities/users/${user.id}`);
  const details = page.getByRole('tabpanel');
  await expect(details.getByRole('definition').filter({ hasText: name })).toBeVisible();

  await page.getByRole('tab', { name: 'History' }).click();
  const entry = page.getByRole('article').first();
  await expect(entry).toContainText('update');
  await expect(entry).toContainText('editor@example.com');
  await expect(entry).toContainText(reason);
  const row = entry.getByRole('row', { name: /Full name/ });
  await expect(row.getByRole('cell')).toHaveText([before, name]);
});
