import { expect, test, type Page } from '@playwright/test';

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
    await createTown(page);
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

test('a guest joins with a shuffled name and reloads the same seat without an account', async ({ page, browser }) => {
    await createTown(page);
    await page.getByRole('button', { name: 'Invite guests' }).click();
    const link = page.getByLabel('Guest invitation link');
    await expect(link).toHaveValue(/\/guest#/);
    const guest = await browser.newContext();
    try {
        const phone = await guest.newPage();
        const accountCalls: string[] = [];
        phone.on('request', request => {
            if (/\/api\/auth\/(register|login)/.test(request.url())) {
                accountCalls.push(new URL(request.url()).pathname);
            }
        });
        await phone.goto(await link.inputValue());
        await phone.getByRole('button', { name: 'Shuffle nickname' }).click();
        const nickname = await phone.getByRole('status', { name: 'Your nickname' }).innerText();
        const redemption = phone.waitForResponse(response => response.url().includes('/guests/requests/'));
        await phone.getByRole('button', { name: 'Join this town' }).click({ timeout: 5000 });
        const response = await redemption;
        if (!response.ok()) {
            const failure = await response.json();
            throw new Error(`Guest admission returned ${response.status()} (${failure.code}): ${failure.message}`);
        }
        await expect(phone.getByRole('heading', { name: 'Your town lobby' })).toBeVisible();
        await expect(phone.getByText(nickname, { exact: true })).toBeVisible();
        await expect(page.locator('#roster li')).toHaveCount(2);
        await phone.reload();
        await expect(phone.getByRole('heading', { name: 'Your town lobby' })).toBeVisible();
        await expect(phone.getByText(nickname, { exact: true })).toBeVisible();
        await expect(page.locator('#roster li')).toHaveCount(2);
        expect(new URL(phone.url()).hash).toBe('');
        expect(accountCalls).toEqual([]);
    }
    finally {
        await guest.close();
    }
});

test('a replaced invitation asks the visitor for a fresh link', async ({ page, browser }) => {
    await createTown(page);
    await page.getByRole('button', { name: 'Invite guests' }).click();
    const link = page.getByLabel('Guest invitation link');
    const previous = await link.inputValue();
    await page.getByRole('button', { name: 'Replace invitation' }).click();
    await expect(link).not.toHaveValue(previous);
    const guest = await browser.newContext();
    try {
        const visitor = await guest.newPage();
        await visitor.goto(previous);
        await visitor.getByRole('button', { name: 'Join this town' }).click();
        await expect(visitor.getByRole('alert')).toContainText('fresh invitation');
        await expect(page.locator('#roster li')).toHaveCount(1);
    }
    finally {
        await guest.close();
    }
});

async function createTown(page: Page): Promise<void> {
    await page.goto('/');
    await page.getByRole('button', { name: 'Play with friends' }).click();
    await page.getByLabel('Username', { exact: true }).fill(`guest-host-${Date.now()}`);
    await page.getByLabel('Password', { exact: true }).fill('x');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Create town' }).click();
}
