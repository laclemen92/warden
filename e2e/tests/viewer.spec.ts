import { expect, test } from '@playwright/test';
import { firstUser, openWithCapabilities, signIn } from './helpers.js';

test.describe('viewer', () => {
  test.beforeEach(async ({ page }) => signIn(page, 'viewer'));

  test('sees no edit controls', async ({ page }) => {
    await openWithCapabilities(page, '/entities/companies');
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New' })).toHaveCount(0);

    const user = await firstUser(page.request);
    await openWithCapabilities(page, `/entities/users/${user.id}`);
    await expect(page.getByRole('heading', { name: String(user.values.email) })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    // Viewers have no admin areas.
    await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
  });

  test('gets 403 from the API for every write', async ({ page }) => {
    const { request } = page;
    const user = await firstUser(request);
    const url = `/api/entities/users/${user.id}`;

    const update = await request.patch(url, {
      data: { version: user.version, values: { full_name: 'Not allowed' } },
    });
    expect(update.status()).toBe(403);
    const create = await request.post('/api/entities/companies', {
      data: { values: { name: 'Not allowed' } },
    });
    expect(create.status()).toBe(403);
    const remove = await request.delete(url, { data: { version: user.version } });
    expect(remove.status()).toBe(403);

    // Nothing changed.
    const after = await request.get(url);
    expect(((await after.json()) as typeof user).version).toBe(user.version);
  });
});
