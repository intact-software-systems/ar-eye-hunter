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

test('the town owner can issue and replace a locally rendered guest QR and link', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await page.getByLabel('Username', { exact: true }).fill(`guest-host-${Date.now()}`);
    await page.getByLabel('Password', { exact: true }).fill('x');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Create town' }).click();
    await page.getByRole('button', { name: 'Invite guests' }).click({ timeout: 5000 });
    const link = page.getByLabel('Guest invitation link');
    const roomId = await page.getByLabel('Room code').inputValue();
    await expect(link).toHaveValue(/\/guest#/);
    const first = new URL(await link.inputValue());
    expect(new URLSearchParams(first.hash.slice(1)).get('room')).toBe(roomId);
    expect(first.search).toBe('');
    await expect(page.getByRole('img', { name: 'Scan to join this town' })).toBeVisible();
    await page.getByRole('button', { name: 'Replace invitation' }).click();
    await expect(link).not.toHaveValue(first.href);
});
