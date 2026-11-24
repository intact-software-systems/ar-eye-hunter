import { expect, test } from '@playwright/test';

test('a friend can shuffle a town nickname and enter practice from an invitation', async ({ page }) => {
    await page.goto('/guest');
    await expect(page.getByRole('heading', { name: 'Town invitation' })).toBeVisible();
    const name = page.getByRole('status', { name: 'Your nickname' });
    await expect(name).toHaveText(/\S/);
    const first = await name.innerText();
    await page.getByRole('button', { name: 'Shuffle nickname' }).click();
    await expect(name).not.toHaveText(first);
    await page.getByRole('link', { name: 'Play solo' }).click();
    await expect(page.getByRole('button', { name: 'Dash and drop' })).toBeVisible();
});
