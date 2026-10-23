import { expect, test, type Page } from '@playwright/test';

test('retains a manual private destination through signed-out reload and cancellation', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Room reference', { exact: true }).fill('private-expedition');
    await page.getByLabel('Room code', { exact: true }).fill('private-code');
    await page.getByRole('button', { name: 'Enter private room', exact: true }).click();
    await expect(page.getByText('Sign in to enter this room.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Sign in to enter this room.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Room reference', { exact: true })).toHaveValue('private-expedition');
    await page.getByRole('button', { name: 'Cancel room entry', exact: true }).click();
    await page.reload();
    await expect(page.getByText('Sign in to enter this room.', { exact: true })).toHaveCount(0);
});

test('rejects a private link for another application without admitting a room', async ({ page }) => {
    const admissions: string[] = [];
    page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/join')) {
            admissions.push(request.url());
        }
    });
    await page.goto(
        '/#rallar-room?applicationId=ar-eye-hunter&workspaceId=default&groupId=wrong-app&joinCode=private-code'
    );
    await expect(page.getByRole('alert')).toContainText('different application or workspace');
    expect(admissions).toEqual([]);
});

test('shares a code expedition, plays together, and returns after code rotation', async ({ browser }) => {
    test.skip(!['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''), 'Requires the paired Relic server.');
    test.setTimeout(180_000);
    const host = await browser.newContext();
    const guest = await browser.newContext();
    const outsider = await browser.newContext();
    try {
        const hostPage = await host.newPage();
        const guestPage = await guest.newPage();
        const outsiderPage = await outsider.newPage();
        await hostPage.goto('/');
        await registerPrivateHunter(hostPage, 'host');
        await expect(hostPage.getByRole('button', { name: 'New code room', exact: true })).toBeVisible();
        await hostPage.getByRole('button', { name: 'New code room', exact: true }).click();
        await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue('');
        const link = await hostPage.getByLabel('Room link', { exact: true }).inputValue();
        await outsiderPage.goto('/');
        await registerPrivateHunter(outsiderPage, 'outsider');
        await expect(outsiderPage.locator('button.room-row')).toHaveCount(0);
        await outsiderPage.goto('about:blank');
        await guestPage.goto(link);
        await expect(guestPage.getByText('Sign in to enter this room.', { exact: true })).toBeVisible();
        await registerPrivateHunter(guestPage, 'guest');
        await playPrivateExpedition(hostPage, guestPage);
        await hostPage.getByRole('button', { name: 'Rotate room code', exact: true }).click();
        await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue(link);
        await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue('');
        await guestPage.reload();
        await expect(guestPage.locator('.turn-plan-status .panel-label')).toHaveText('Round 2');
        await hostPage.screenshot({ path: 'tmp/private-room-entry/relic-host.png', fullPage: true });
        await guestPage.screenshot({ path: 'tmp/private-room-entry/relic-guest.png', fullPage: true });
        const currentLink = await hostPage.getByLabel('Room link', { exact: true }).inputValue();
        await Promise.all([hostPage.goto('about:blank'), guestPage.goto('about:blank')]);
        await outsiderPage.goto(link);
        await expect(outsiderPage.getByRole('alert')).toContainText('Room entry was denied');
        const fields = new URLSearchParams(new URL(currentLink).hash.slice('#rallar-room?'.length));
        await outsiderPage.getByLabel('Room code', { exact: true }).fill(fields.get('joinCode') ?? '');
        await outsiderPage.getByRole('button', { name: 'Enter private room', exact: true }).click();
        await expect(outsiderPage.getByText(`Entered ${fields.get('groupId')}.`, { exact: true })).toBeVisible();
    }
    finally {
        await Promise.all([host.close(), guest.close(), outsider.close()]);
    }
});

test('replaces a saved room with an invitation and enforces revocation before admission', async ({ browser }) => {
    test.skip(!['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''), 'Requires the paired Relic server.');
    const host = await browser.newContext();
    const guest = await browser.newContext();
    try {
        const hostPage = await host.newPage();
        const guestPage = await guest.newPage();
        await hostPage.goto('/');
        await registerPrivateHunter(hostPage, 'invite-host');
        await hostPage.getByRole('button', { name: 'New code room', exact: true }).click();
        await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue('');
        await guestPage.goto(await hostPage.getByLabel('Room link', { exact: true }).inputValue());
        await registerPrivateHunter(guestPage, 'invite-guest');
        await expect(guestPage.getByRole('button', { name: /Join as/ })).toBeVisible();
        const principal = await guestPage.getByLabel('Your account reference', { exact: true }).inputValue();
        await hostPage.getByRole('button', { name: 'New invite-only room', exact: true }).click();
        const linkField = hostPage.getByLabel('Room link', { exact: true });
        await expect(linkField).toHaveValue(/#rallar-room\?/);
        await expect(linkField).not.toHaveValue(/joinCode=/);
        const link = await linkField.inputValue();
        const groupId = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
        await guestPage.goto(link);
        await expect(guestPage.getByRole('alert')).toContainText('Room entry was denied');
        await hostPage.getByLabel('Account reference', { exact: true }).fill(principal);
        await hostPage.getByRole('button', { name: 'Invite account', exact: true }).click();
        await hostPage.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
        await expect(hostPage.getByRole('button', { name: 'Revoke invitation', exact: true })).toHaveCount(0);
        await guestPage.getByRole('button', { name: 'Retry room entry', exact: true }).click();
        await expect(guestPage.getByRole('alert')).toContainText('Room entry was denied');
        await hostPage.getByRole('button', { name: 'Invite account', exact: true }).click();
        await expect(hostPage.getByRole('button', { name: 'Revoke invitation', exact: true })).toHaveCount(1);
        await hostPage.goto('about:blank');
        await guestPage.getByRole('button', { name: 'Retry room entry', exact: true }).click();
        await expect(guestPage.getByText(`Entered ${groupId}.`, { exact: true })).toBeVisible();
        await expect(guestPage.locator('.lobby-party-row')).toHaveCount(0);
        await guestPage.reload();
        await expect(guestPage.getByText(`Entered ${groupId}.`, { exact: true })).toBeVisible();
        await expect(guestPage.getByRole('button', { name: /Join as/ })).toBeVisible();
    }
    finally {
        await Promise.all([host.close(), guest.close()]);
    }
});

async function registerPrivateHunter(page: Page, role: string): Promise<void> {
    const suffix = crypto.randomUUID();
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(`${role}-${suffix}`);
    await page.getByLabel('Display name', { exact: true }).fill(role);
    await page.getByLabel('Password', { exact: true }).fill(`private-room-${suffix}`);
    await page.getByRole('button', { name: 'Create Hunter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New Room', exact: true })).toBeVisible();
}

async function playPrivateExpedition(host: Page, guest: Page): Promise<void> {
    await expect(guest.getByRole('button', { name: /Join as/ })).toBeVisible();
    await expect(guest.locator('.lobby-party-row')).toHaveCount(0);
    await host.getByRole('button', { name: /Join as/ }).click();
    await guest.getByRole('button', { name: /Join as/ }).click();
    await expect(host.locator('.lobby-party-row')).toHaveCount(2);
    await expect(guest.locator('.lobby-party-row')).toHaveCount(2);
    await host.locator('.lobby-begin-btn').click();
    await expect(guest.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
    await host.getByRole('button', { name: 'Submit Plan' }).click();
    await guest.getByRole('button', { name: 'Submit Plan' }).click();
    await expect(host.locator('.turn-plan-status .panel-label')).toHaveText('Round 2');
    await expect(guest.locator('.turn-plan-status .panel-label')).toHaveText('Round 2');
}
