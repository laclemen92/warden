import { expect, test } from '@playwright/test';
import { signIn, type RecordItem } from './helpers.js';

test('editor previews and runs a custom action, audited as one entry', async ({ page }) => {
  await signIn(page, 'editor');
  // The last user, so this doesn't race the edit test on the first one.
  const res = await page.request.get('/api/entities/users?limit=1&sort=-id');
  const [user] = ((await res.json()) as { items: RecordItem[] }).items;
  expect(user).toBeDefined();
  // Any company other than the current one; the example has 25.
  const target = (Number(user!.values.company_id ?? 0) % 25) + 1;

  await page.goto(`/entities/users/${user!.id}`);
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Move to company' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Move to company' });
  await expect(dialog).toContainText('Can change: Users (update), Orders (update)');

  await dialog.getByRole('combobox', { name: /New company/ }).click();
  await page.getByRole('searchbox', { name: 'Search companies' }).fill(`Company ${target}`);
  await page.getByRole('option', { name: new RegExp(`^Company ${target} \\(`) }).click();
  // Actions require an internal note by default; Preview stays disabled until it's long enough.
  await dialog.getByRole('textbox', { name: 'Internal note' }).fill('e2e: moving to test');
  await dialog.getByRole('button', { name: 'Preview' }).click();

  const changes = dialog.getByRole('region', { name: 'Changes' });
  await expect(changes).toContainText('Users (1 update)');
  await dialog.getByRole('button', { name: 'Run' }).click();
  await expect(dialog.getByRole('status')).toContainText(`to Company ${target}`);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // The record shows its new company, and its history the change as part of the action.
  await expect(
    page.getByRole('tabpanel').getByRole('link', { name: `Company ${target}`, exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'History' }).click();
  const [change, parent] = [page.getByRole('article').nth(0), page.getByRole('article').nth(1)];
  await expect(change).toContainText('as part of Move to company');
  await expect(change.getByRole('row', { name: /Company/ })).toBeVisible();
  await expect(parent).toContainText('Move to company');
  await expect(parent).toContainText(String(target));
  await expect(parent).toContainText('e2e: moving to test');
});
