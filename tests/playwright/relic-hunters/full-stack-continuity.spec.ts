import { expect, type Page } from '@playwright/test';
import { roomBrowserTest } from '../room-browser-fixture.ts';
import { registerRelicHunter, waitForExpeditionScene } from './relic-browser-room-workflow.ts';

roomBrowserTest(
    'continues an expedition after the Keeper leaves through the visible controls',
    async ({ page: host, guest }) => {
        const link = await joinTwoHunters(host, guest);
        await expect(guest.getByRole('button', { name: 'Take over as Keeper', exact: true })).toBeDisabled();
        await host.getByRole('button', { name: 'Leave expedition', exact: true }).click();
        await expect(host.locator('.lobby-party-row')).toHaveCount(1);
        await expect(guest.locator('.lobby-begin-btn')).toBeEnabled();
        await expect(host.getByLabel('Room link', { exact: true })).toHaveValue(link);
        await guest.locator('.lobby-begin-btn').click();
        await guest.getByRole('button', { name: 'Submit Plan' }).click();
        await expect(guest.getByRole('region', { name: 'Round review', exact: true })).toBeVisible();
        await expect(host.getByRole('button', { name: 'Submit Plan' })).toHaveCount(0);
        await guest.getByRole('button', { name: 'Skip review', exact: true }).click();
        await expect(guest.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
    }
);

roomBrowserTest(
    'recovers the same hunter after disconnect without reclaiming Keeper authority',
    async ({ page: host, guest }) => {
        const link = await joinTwoHunters(host, guest);
        await host.locator('.lobby-begin-btn').click();
        await host.getByRole('button', { name: 'Submit Plan' }).click();
        await guest.getByRole('button', { name: 'Submit Plan' }).click();
        await expect(guest.getByRole('region', { name: 'Round review', exact: true })).toBeVisible();
        await host.goto('about:blank');
        // The server lease, not a browser offline hint, governs takeover. Allow the real 60s lease to expire.
        await expect(guest.getByRole('button', { name: 'Take over as Keeper', exact: true }))
            .toBeEnabled({ timeout: 70_000 });
        await guest.getByRole('button', { name: 'Take over as Keeper', exact: true }).click();
        await expect(guest.getByRole('button', { name: 'Take over as Keeper', exact: true })).toHaveCount(0);
        const review = guest.getByRole('button', { name: 'Skip review', exact: true });
        if (await review.isVisible()) {
            await review.click();
        }
        await expect(guest.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        await host.goto(link);
        await waitForExpeditionScene(host);
        await expect(host.getByRole('button', { name: 'Leave expedition', exact: true })).toBeVisible();
        await expect(host.getByRole('button', { name: 'Take over as Keeper', exact: true })).toBeDisabled();
        await expect(host.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        await host.getByRole('button', { name: 'Submit Plan' }).click();
        await guest.getByRole('button', { name: 'Submit Plan' }).click();
        await expect(guest.getByRole('region', { name: 'Round review', exact: true })).toBeVisible();
    }
);

roomBrowserTest(
    'withdraws a locked hunter and lets the remaining hunter finish without Reset',
    async ({ page: host, guest }) => {
        await joinTwoHunters(host, guest);
        await host.locator('.lobby-begin-btn').click();
        await guest.getByRole('button', { name: 'Submit Plan' }).click();
        await guest.getByRole('button', { name: 'Leave expedition', exact: true }).click();
        await expect(guest.getByRole('button', { name: 'Leave expedition', exact: true })).toHaveCount(0);
        await host.getByRole('button', { name: 'Submit Plan' }).click();
        await expect(host.getByRole('region', { name: 'Round review', exact: true })).toBeVisible();
        await host.getByRole('button', { name: 'Skip review', exact: true }).click();
        await expect(host.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        await host.getByRole('button', { name: 'Leave expedition', exact: true }).click();
        await expect(host.getByRole('button', { name: 'Leave expedition', exact: true })).toHaveCount(0);
        await expect(guest.getByRole('button', { name: 'Submit Plan' })).toHaveCount(0);
        await expect(host.getByText(/The castle collapses as the expedition ends/).first()).toBeVisible();
    }
);

roomBrowserTest('withdraws only this hunter when two sessions use the same account', async ({ page: host, guest }) => {
    const credentials = await registerRelicHunter(host, 'same-account');
    await host.getByRole('button', { name: 'New Room', exact: true }).click();
    await waitForExpeditionScene(host);
    const link = await host.getByLabel('Room link', { exact: true }).inputValue();
    await host.getByRole('button', { name: /Join as/ }).click();
    await guest.goto(link);
    await guest.getByLabel('Username', { exact: true }).fill(credentials.username);
    await guest.getByLabel('Password', { exact: true }).fill(credentials.password);
    await guest.getByRole('button', { name: 'Enter', exact: true }).click();
    await waitForExpeditionScene(guest);
    await guest.getByRole('button', { name: /Join as/ }).click();
    await expect(host.locator('.lobby-party-row')).toHaveCount(2);
    await host.getByRole('button', { name: 'Leave expedition', exact: true }).click();
    await expect(guest.locator('.lobby-party-row')).toHaveCount(1);
    await expect(host.getByLabel('Room link', { exact: true })).toHaveValue(link);
    await expect(guest.getByLabel('Room link', { exact: true })).toHaveValue(link);
    await expect(guest.locator('.lobby-begin-btn')).toBeEnabled();
    await guest.locator('.lobby-begin-btn').click();
    await guest.getByRole('button', { name: 'Submit Plan' }).click();
    await expect(guest.getByRole('region', { name: 'Round review', exact: true })).toBeVisible();
});

async function joinTwoHunters(host: Page, guest: Page): Promise<string> {
    await registerRelicHunter(host, 'continuity-keeper');
    await host.getByRole('button', { name: 'New Room', exact: true }).click();
    await waitForExpeditionScene(host);
    const link = await host.getByLabel('Room link', { exact: true }).inputValue();
    const roomId = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
    if (!roomId) {
        throw new Error('Expected the created expedition room reference');
    }
    await registerRelicHunter(guest, 'continuity-hunter');
    await guest.getByLabel('Room reference', { exact: true }).fill(roomId);
    await guest.getByRole('button', { name: 'Enter room', exact: true }).click();
    await waitForExpeditionScene(guest);
    await host.getByRole('button', { name: /Join as/ }).click();
    await guest.getByRole('button', { name: /Join as/ }).click();
    await expect(host.locator('.lobby-party-row')).toHaveCount(2);
    return link;
}
