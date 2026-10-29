import { expect } from '@playwright/test';
import { roomBrowserTest } from '../room-browser-fixture.ts';
import { registerRelicHunter, waitForExpeditionScene } from './relic-browser-room-workflow.ts';

roomBrowserTest(
    'watches through visible controls, recovers watching, and promotes only before an expedition starts',
    async ({ page: host, guest: watcher }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the paired Relic server.');
        await registerRelicHunter(host, 'host');
        await host.getByRole('button', { name: 'New Room', exact: true }).click();
        await expect(host.getByLabel('Room link', { exact: true })).toHaveValue(/#rallar-room\?/);
        await waitForExpeditionScene(host);
        const link = await host.getByLabel('Room link', { exact: true }).inputValue();
        const roomId = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!roomId) {
            throw new Error('The host link must identify its expedition room.');
        }
        await registerRelicHunter(watcher, 'watcher');
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
        await expect(watcher.getByRole('button', { name: 'Submit Plan' })).toHaveCount(0);
        await expect(watcher.getByRole('button', { name: 'Join Expedition', exact: true })).toHaveCount(0);
        await host.getByRole('button', { name: 'Submit Plan' }).click();
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
);

roomBrowserTest(
    'offers Watch for a full player roster without allowing promotion',
    async ({ page: host, guest: watcher }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the paired Relic server.');
        await registerRelicHunter(host, 'full-host');
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
        await registerRelicHunter(watcher, 'full-watcher');
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
);
