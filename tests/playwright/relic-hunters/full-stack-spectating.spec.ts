import { expect, test, type Page } from '@playwright/test';

test('watches through visible controls, recovers watching, and promotes only before an expedition starts', async ({ browser }) => {
    test.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the paired Relic server.');
    const hostContext = await browser.newContext();
    const watcherContext = await browser.newContext();
    try {
        const host = await hostContext.newPage();
        const watcher = await watcherContext.newPage();
        await registerSpectatingHunter(host, 'host');
        await host.getByRole('button', { name: 'New Room', exact: true }).click();
        await expect(host.getByLabel('Room link', { exact: true })).toHaveValue(/#rallar-room\?/);
        await waitForExpeditionScene(host);
        const link = await host.getByLabel('Room link', { exact: true }).inputValue();
        const roomId = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!roomId) {
            throw new Error('The host link must identify its expedition room.');
        }
        await registerSpectatingHunter(watcher, 'watcher');
        await watcher.getByLabel('Room reference', { exact: true }).fill(roomId);
        await watcher.getByLabel('Participation', { exact: true }).selectOption('spectator');
        await watcher.getByRole('button', { name: 'Watch room', exact: true }).click();
        await waitForExpeditionScene(watcher);
        await expect(watcher.getByText('Watching', { exact: true })).toBeVisible();
        await expect(watcher.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
        await expect(watcher.locator('.lobby-ready-btn')).toHaveCount(0);
        await watcher.reload();
        await expect(watcher.getByRole('button', { name: 'New Room', exact: true })).toBeEnabled({ timeout: 30_000 });
        await waitForExpeditionScene(watcher);
        await expect(watcher.getByText('Watching', { exact: true })).toBeVisible();
        await host.locator('.lobby-ready-btn').click();
        await expect(host.locator('.lobby-party-row')).toHaveCount(1);
        await expect(host.locator('.lobby-begin-btn')).toBeEnabled();
        await host.locator('.lobby-begin-btn').click();
        await expect(watcher.getByRole('button', { name: 'Join as player', exact: true })).toBeDisabled();
        await expect(watcher.getByRole('button', { name: 'Submit Plan', exact: true })).toHaveCount(0);
        await expect(watcher.getByRole('button', { name: 'Join Expedition', exact: true })).toHaveCount(0);
        await host.getByRole('button', { name: 'Submit Plan', exact: true }).click();
        await expect(host.getByRole('region', { name: 'Round review', exact: true })).toBeVisible();
        await expect(watcher.getByRole('region', { name: 'Round review', exact: true })).toBeVisible();
        await host.getByRole('button', { name: 'Reset', exact: true }).click();
        await expect(host.locator('.lobby-party-row')).toHaveCount(0);
        await host.locator('.lobby-ready-btn').click();
        await expect(host.locator('.lobby-party-row')).toHaveCount(1);
        await watcher.getByRole('button', { name: 'Join as player', exact: true }).click();
        await expect(watcher.getByText('Watching', { exact: true })).toHaveCount(0);
        await expect(watcher.locator('.lobby-ready-btn')).toBeEnabled();
        await expect(host.locator('.lobby-party-row')).toHaveCount(1);
        await watcher.locator('.lobby-ready-btn').click();
        await expect(host.locator('.lobby-party-row')).toHaveCount(2);
        await expect(watcher.getByLabel('Participation', { exact: true }).locator('option[value="spectator"]'))
            .toHaveJSProperty('disabled', true);
        await watcher.getByRole('button', { name: 'Leave room', exact: true }).click();
        await expect(watcher.getByLabel('Relic Hunters opening scene', { exact: true }))
            .toHaveAttribute('data-scene-ready', 'true', { timeout: 30_000 });
        await expect(watcher.getByRole('button', { name: 'Leave room', exact: true })).toHaveCount(0);
    }
    finally {
        await hostContext.close();
        await watcherContext.close();
    }
});

test('offers Watch for a full player roster without allowing promotion', async ({ browser }) => {
    test.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the paired Relic server.');
    const hostContext = await browser.newContext();
    const watcherContext = await browser.newContext();
    try {
        const host = await hostContext.newPage();
        const watcher = await watcherContext.newPage();
        await registerSpectatingHunter(host, 'full-host');
        // A one-player capacity exercises the same server admission limit without unrelated player scenes.
        await host.route('**/groups/requests/*', async (route) => {
            await route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), maxMembers: 1 }) });
        });
        const created = host.waitForResponse((response) =>
            response.request().method() === 'POST' && response.url().includes('/groups/requests/')
        );
        await host.getByRole('button', { name: 'New Room', exact: true }).click();
        const room = await (await created).json();
        await waitForExpeditionScene(host);
        await registerSpectatingHunter(watcher, 'full-watcher');
        await watcher.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(
            watcher.getByRole('button', { name: `${room.group.displayName} 1 player · 0 watching · Full`, exact: true })
        ).toBeDisabled();
        await watcher.getByRole('button', { name: `Watch ${room.group.displayName}`, exact: true }).click();
        await waitForExpeditionScene(watcher);
        await expect(watcher.getByText('Watching', { exact: true })).toBeVisible();
        await expect(watcher.getByRole('button', { name: 'Join as player', exact: true })).toBeDisabled();
        await host.locator('.lobby-ready-btn').click();
        await expect(host.locator('.lobby-begin-btn')).toBeEnabled();
        await expect(host.locator('.lobby-party-row')).toHaveCount(1);
    }
    finally {
        await hostContext.close();
        await watcherContext.close();
    }
});

async function registerSpectatingHunter(page: Page, role: string): Promise<void> {
    const suffix = crypto.randomUUID();
    await page.goto('/');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(`spectating-${role}-${suffix}`);
    await page.getByLabel('Display name', { exact: true }).fill(role);
    await page.getByLabel('Password', { exact: true }).fill(`spectating-${suffix}`);
    await page.getByRole('button', { name: 'Create Hunter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New Room', exact: true })).toBeEnabled();
}

async function waitForExpeditionScene(page: Page): Promise<void> {
    // A new Babylon context can block browser tasks while portable SwiftShader initializes.
    // Require the actual expedition frame before testing the room's visible participation state.
    await expect(page.locator('canvas.relic-scene[data-scene-runtime="next"]'))
        .toHaveAttribute('data-scene-ready', 'true', { timeout: 30_000 });
}
