import { expect, type Page } from '@playwright/test';
import { observeBrowserWebGlContexts } from '../../../packages/shared-test/observe-browser-web-gl-contexts.ts';
import { roomBrowserTest } from '../room-browser-fixture.ts';
import { registerRelicHunter, waitForExpeditionScene } from './relic-browser-room-workflow.ts';

roomBrowserTest(
    'continues an expedition after the Keeper leaves through the visible controls',
    async ({ page: host, guest }, testInfo) => {
        const link = await joinTwoHunters(host, guest);
        await expect(guest.getByRole('button', { name: 'Take over as Keeper', exact: true })).toBeDisabled();
        await host.getByRole('button', { name: 'Leave expedition', exact: true }).click();
        await expect(host.locator('.lobby-party-row')).toHaveCount(1);
        await expect(guest.locator('.lobby-begin-btn')).toBeEnabled();
        await guest.screenshot({ path: testInfo.outputPath('keeper-after-departure.png') });
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
    await host.getByRole('button', { name: 'New unlisted room', exact: true }).click();
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

roomBrowserTest(
    'recovers an uncertain Join after reload and then withdraws through visible controls',
    async ({ page }) => {
        await registerRelicHunter(page, 'join-recovery');
        await page.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        await waitForExpeditionScene(page);
        const requestIds: string[] = [];
        await page.route('**/commands/requests/*', async (route) => {
            if (route.request().postDataJSON()?.kind !== 'join-expedition') {
                await route.continue();
                return;
            }
            requestIds.push(route.request().url());
            if (requestIds.length === 1) {
                const committed = await route.fetch();
                expect(committed.ok()).toBe(true);
                await route.abort('failed');
            }
            else {
                await route.continue();
            }
        });
        await page.getByRole('button', { name: /Join as/ }).click();
        await expect(page.getByText('Failed to fetch', { exact: true }).first()).toBeVisible();
        await page.reload();
        await waitForExpeditionScene(page);
        await expect(page.getByRole('button', { name: 'Leave expedition', exact: true })).toBeEnabled();
        expect(requestIds).toHaveLength(2);
        expect(requestIds[1]).toBe(requestIds[0]);
        await page.getByRole('button', { name: 'Leave expedition', exact: true }).click();
        await expect(page.locator('.lobby-party-row')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Join as/ })).toBeEnabled();
    }
);

roomBrowserTest(
    'allocates only native expedition graphics across room hydration',
    async ({ page: host, guest }) => {
        await host.addInitScript(observeBrowserWebGlContexts);
        await registerRelicHunter(guest, 'hydration-owner');
        await guest.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        await waitForExpeditionScene(guest);
        const sourceLink = await guest.getByLabel('Room link', { exact: true }).inputValue();
        const sourceId = new URLSearchParams(new URL(sourceLink).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!sourceId) {
            throw new Error('Expected the source expedition room reference');
        }
        await registerRelicHunter(host, 'hydration-hunter');
        await host.getByLabel('Room reference', { exact: true }).fill(sourceId);
        await host.getByRole('button', { name: 'Enter room', exact: true }).click();
        await waitForExpeditionScene(host);
        await host.getByRole('button', { name: /Join as/ }).click();
        await host.getByRole('button', { name: 'Leave expedition', exact: true }).click();
        await expect(host.getByRole('button', { name: /Join as/ })).toBeEnabled();
        // interaction: only the source expedition has allocated a graphics context.
        await expect(host.locator('html')).toHaveAttribute('data-test-webgl-contexts', '1');

        await guest.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        const destinationLink = guest.getByLabel('Room link', { exact: true });
        await expect(destinationLink).not.toHaveValue(sourceLink);
        const destinationId = new URLSearchParams(
            new URL(await destinationLink.inputValue()).hash.slice('#rallar-room?'.length)
        )
            .get('groupId');
        if (!destinationId) {
            throw new Error('Expected the destination expedition room reference');
        }
        const hydrationRequested = Promise.withResolvers<void>();
        const releaseHydration = Promise.withResolvers<void>();
        await host.route(`**/api/relic/games/${destinationId}`, async (route) => {
            if (route.request().method() !== 'GET') {
                await route.continue();
                return;
            }
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            hydrationRequested.resolve();
            await releaseHydration.promise;
            await route.fulfill({ response });
        });
        try {
            await host.getByLabel('Room reference', { exact: true }).fill(destinationId);
            await host.getByRole('button', { name: 'Enter room', exact: true }).click();
            await hydrationRequested.promise;
            const entry = host.getByRole('region', { name: 'Shared room entry', exact: true });
            await expect(entry.getByText(`Entered ${destinationId}.`, { exact: true })).toBeVisible();
            // interaction: admission must not allocate another native context before its snapshot hydrates.
            await expect(host.locator('html')).toHaveAttribute('data-test-webgl-contexts', '1');
            releaseHydration.resolve();
            await waitForExpeditionScene(host);
            // interaction: completing hydration adds only the destination expedition's graphics context.
            await expect(host.locator('html')).toHaveAttribute('data-test-webgl-contexts', '2');
            await expect(entry.getByRole('alert')).toHaveCount(0);
            await host.getByRole('button', { name: /Join as/ }).click();
            await expect(host.getByRole('button', { name: 'Leave expedition', exact: true })).toBeEnabled();
        }
        finally {
            releaseHydration.resolve();
        }
    }
);

roomBrowserTest(
    'withdraws across shared-session tabs and preserves withdrawal on room re-entry',
    async ({ page: host }) => {
        await host.addInitScript(observeBrowserWebGlContexts);
        await registerRelicHunter(host, 'shared-session');
        // interaction: signing in does not allocate graphics for decorative opening artwork.
        expect(await host.locator('html').getAttribute('data-test-webgl-contexts')).toBeNull();
        await host.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        await waitForExpeditionScene(host);
        const link = await host.getByLabel('Room link', { exact: true }).inputValue();
        const other = await host.context().newPage();
        await other.addInitScript(observeBrowserWebGlContexts);
        await other.goto(link);
        await waitForExpeditionScene(other, 'shared-context');
        // interaction: direct room recovery allocates only the destination renderer, not a discarded opening context.
        await expect(other.locator('html')).toHaveAttribute('data-test-webgl-contexts', '1');
        const committed = Promise.withResolvers<void>();
        const response = Promise.withResolvers<void>();
        await host.route('**/commands/requests/*', async (route) => {
            if (route.request().postDataJSON()?.kind !== 'join-expedition') {
                await route.continue();
                return;
            }
            const result = await route.fetch();
            expect(result.ok()).toBe(true);
            committed.resolve();
            await response.promise;
            await route.fulfill({ response: result });
        });
        try {
            await host.getByRole('button', { name: /Join as/ }).click();
            await committed.promise;
            const membershipRemoval = other.waitForResponse((result) =>
                result.request().method() === 'PUT' && result.url().includes('/members/')
            );
            await other.getByRole('button', { name: 'Leave room', exact: true }).click();
            await expect(other.getByRole('button', { name: 'Leave room', exact: true })).toBeDisabled();
            response.resolve();
            await expect(host.getByRole('button', { name: 'Leave expedition', exact: true })).toBeVisible();
            await expect(other.locator('.lobby-party-row')).toHaveCount(0);
            // Leaving disconnects this session; the account remains because it is the room's last owner.
            expect((await membershipRemoval).status()).toBe(403);
            // Open the link in a new document to verify withdrawal independently of either tab's cache.
            // A fragment-only navigation retains the departed runtime instead of loading the saved state.
            await other.goto('about:blank');
            await other.goto(link);
            await waitForExpeditionScene(other, 'shared-context');
            await expect(other.locator('html')).toHaveAttribute('data-test-webgl-contexts', '1');
            await expect(other.getByLabel('Room link', { exact: true })).toHaveValue(link);
            await expect(other.locator('.lobby-party-row')).toHaveCount(0);
            await expect(other.getByRole('button', { name: /Join as/ })).toBeEnabled();
        }
        finally {
            response.resolve();
            await other.close();
        }
    }
);

roomBrowserTest(
    'refuses an implicit room switch after another tab admits the shared hunter',
    async ({ page: host }) => {
        await registerRelicHunter(host, 'shared-navigation');
        await host.getByRole('button', { name: 'New unlisted room', exact: true }).click();
        await waitForExpeditionScene(host);
        const link = await host.getByLabel('Room link', { exact: true }).inputValue();
        const other = await host.context().newPage();
        await other.goto(link);
        await waitForExpeditionScene(other, 'shared-context');
        const requested = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        await host.route('**/commands/requests/*', async (route) => {
            if (route.request().postDataJSON()?.kind === 'join-expedition') {
                requested.resolve();
                await release.promise;
            }
            await route.continue();
        });
        try {
            await host.getByRole('button', { name: /Join as/ }).click();
            await requested.promise;
            await other.getByRole('button', { name: 'New Room', exact: true }).click();
            release.resolve();
            await expect(
                other.getByText('Use Leave expedition before entering or watching another expedition.', { exact: true })
                    .first()
            ).toBeVisible();
            await expect(other.getByLabel('Room link', { exact: true })).toHaveValue(link);
            await expect(host.locator('.lobby-party-row')).toHaveCount(1);
        }
        finally {
            release.resolve();
            await other.close();
        }
    }
);

async function joinTwoHunters(host: Page, guest: Page): Promise<string> {
    await registerRelicHunter(host, 'continuity-keeper');
    await host.getByRole('button', { name: 'New unlisted room', exact: true }).click();
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
