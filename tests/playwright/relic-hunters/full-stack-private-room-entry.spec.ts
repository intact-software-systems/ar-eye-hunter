import {
    expect,
    test,
    type Page
} from '@playwright/test';

import { roomBrowserTest } from '../room-browser-fixture.ts';

test('retains a manual private destination through signed-out reload and cancellation', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Room reference', { exact: true }).fill('private-expedition');
    await page.getByLabel('Room code', { exact: true }).fill('private-code');
    await page.getByRole('button', { name: 'Enter room', exact: true }).click();
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

roomBrowserTest(
    'shares a code expedition, plays together, and returns after code rotation',
    async ({ browser, page: hostPage, guest: guestPage }, testInfo) => {
        roomBrowserTest.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        roomBrowserTest.setTimeout(180_000);
        const outsider = await browser.newContext();
        try {
            const outsiderPage = await outsider.newPage();
            await hostPage.goto('/');
            await registerPrivateHunter(hostPage, 'host');
            await expect(hostPage.getByRole('button', { name: 'New code room', exact: true })).toBeVisible();
            await hostPage.getByRole('button', { name: 'New code room', exact: true }).click();
            await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue('');
            const link = await hostPage.getByLabel('Room link', { exact: true }).inputValue();
            await outsiderPage.goto('/');
            await registerPrivateHunter(outsiderPage, 'outsider');
            await expect(outsiderPage.getByRole('button', { name: 'New Room', exact: true })).toBeEnabled();
            await expect(outsiderPage.locator('button.room-row')).toHaveCount(0);
            await outsiderPage.goto('about:blank');
            await guestPage.goto(link);
            await expect(guestPage.getByText('Sign in to enter this room.', { exact: true })).toBeVisible();
            await registerPrivateHunter(guestPage, 'guest');
            await playPrivateExpedition(hostPage, guestPage);
            await hostPage.getByRole('button', { name: 'Rotate room code', exact: true }).click();
            await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue(link);
            await expect(hostPage.getByLabel('Room link', { exact: true })).not.toHaveValue('');
            const currentLink = await hostPage.getByLabel('Room link', { exact: true }).inputValue();
            const fields = new URLSearchParams(new URL(currentLink).hash.slice('#rallar-room?'.length));
            const groupId = fields.get('groupId');
            const joinCode = fields.get('joinCode');
            if (!groupId || !joinCode) {
                throw new Error('The generated private-room link must contain its reference and code.');
            }
            await hostPage.screenshot({ path: testInfo.outputPath('relic-host.png'), fullPage: true });
            // The host's assertions are complete; release its software WebGL renderer before reload.
            await hostPage.goto('about:blank');
            await guestPage.reload();
            await expect(guestPage.locator('.turn-plan-status .panel-label')).toHaveText('Round 2');
            await guestPage.screenshot({ path: testInfo.outputPath('relic-guest.png'), fullPage: true });
            await guestPage.goto('about:blank');
            await outsiderPage.goto(link);
            await expect(outsiderPage.getByRole('alert')).toContainText('Room entry was denied');
            await outsiderPage.getByLabel('Room code', { exact: true }).fill(joinCode);
            await outsiderPage.getByRole('button', { name: 'Enter room', exact: true }).click();
            await expect(outsiderPage.getByText(`Entered ${groupId}.`, { exact: true })).toBeVisible();
        }
        finally {
            await outsider.close();
        }
    }
);

roomBrowserTest(
    'replaces a saved room with an invitation and enforces revocation before admission',
    async ({ page: hostPage, guest: guestPage }) => {
        roomBrowserTest.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
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
);

roomBrowserTest(
    'shares an unlisted expedition and keeps participants when the host hides it',
    async ({ page: host, guest }, testInfo) => {
        roomBrowserTest.skip(
            !['1', 'true'].includes(process.env.RELIC_HUNTERS_FULL_STACK ?? ''),
            'Requires the paired Relic server.'
        );
        await host.goto('/');
        await registerPrivateHunter(host, 'unlisted-host');
        await expect(host.getByRole('button', { name: 'New unlisted room', exact: true })).toBeVisible();
        await host.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        await expect(host.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        const link = await host.getByLabel('Room link', { exact: true }).inputValue();
        expect(link).toContain('#rallar-room?');
        expect(link).not.toContain('joinCode=');
        const roomName = await host.locator('.room-row.active span').innerText();
        await guest.goto('/');
        await registerPrivateHunter(guest, 'unlisted-guest');
        await guest.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guest.locator('.room-row').filter({ hasText: roomName })).toHaveCount(0);
        await host.route('**/groups/*/requests/*', async (route) => {
            if (route.request().method() === 'PUT' && route.request().postDataJSON().directoryListing) {
                await route.fulfill({ status: 403, json: { error: 'Listing unavailable' } });
            }
            else {
                await route.continue();
            }
        });
        await host.getByRole('button', { name: 'List room', exact: true }).click();
        await expect(host.getByRole('alert')).toContainText('Could not change room listing');
        await expect(host.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        await host.unroute('**/groups/*/requests/*');
        await host.getByRole('button', { name: 'List room', exact: true }).click();
        await expect(host.getByRole('button', { name: 'Unlist room', exact: true })).toBeEnabled();
        await guest.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guest.locator('.room-row').filter({ hasText: roomName })).toHaveCount(1);
        await host.getByRole('button', { name: 'Unlist room', exact: true }).click();
        await expect(host.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        await guest.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guest.locator('.room-row').filter({ hasText: roomName })).toHaveCount(0);
        await guest.goto(link);
        await expect(guest.getByRole('button', { name: /Join as/ })).toBeVisible();
        await host.getByRole('button', { name: 'List room', exact: true }).click();
        await host.getByRole('button', { name: 'Unlist room', exact: true }).click();
        await playPrivateExpedition(host, guest);
        await guest.screenshot({ path: testInfo.outputPath('unlisted-expedition-participating.png'), fullPage: true });
    }
);

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
