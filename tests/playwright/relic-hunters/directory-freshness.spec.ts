import { expect, test } from '@playwright/test';

import type { GroupDirectoryEntry } from '../../../packages/shared/api/group-directory/group-directory-types.ts';
import {
    createGroupSnapshot,
    initBrowserTestTransport,
    startRelicBrowserBackend
} from './relic-browser-backend.ts';
import { createRelicSnapshotWithPlayers } from './relic-browser-snapshots.ts';

const DIRECTORY_URL = '**/api/state/apps/rallar-server/workspaces/default/group-directory?*';

test(
    'discovers and removes public rooms automatically, retries failures, and preserves the selected expedition',
    async ({ page }, testInfo) => {
        await page.clock.install();
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [createGroupSnapshot({ onlineMemberCount: 2 })],
            relicSnapshot: createRelicSnapshotWithPlayers(2, 'lobby')
        });
        let entries: GroupDirectoryEntry[] = [];
        let unavailable = false;
        await page.route(DIRECTORY_URL, async (route) => {
            if (unavailable) {
                await route.fulfill({ status: 400, json: { error: 'Directory unavailable' } });
            }
            else {
                await route.fulfill({ json: { entries, nextCursor: null } });
            }
        });
        await page.goto('/');
        await page.getByLabel('Username', { exact: true }).fill('alice');
        await page.getByLabel('Password', { exact: true }).fill('test-only-password');
        await page.getByRole('button', { name: 'Enter', exact: true }).click();
        await expect(page.getByText('No public expeditions found.')).toBeVisible();
        await page.getByRole('button', { name: 'Relic Hunters Expedition', exact: false }).click();
        await expect(page.getByRole('region', { name: 'Expedition hosting' }).getByText('room-1', { exact: true }))
            .toBeVisible();
        await expect(page.getByRole('button', { name: '✓ Ready', exact: true })).toBeDisabled();

        entries = [publicExpedition()];
        await page.clock.fastForward(30_000);
        await expect(page.getByRole('button', { name: /New public expedition.*1 online/ })).toBeEnabled();
        await expect(page.getByRole('region', { name: 'Expedition hosting' }).getByText('room-1', { exact: true }))
            .toBeVisible();
        await expect(page.getByRole('button', { name: '✓ Ready', exact: true })).toBeDisabled();
        unavailable = true;
        await page.clock.fastForward(30_000);
        await expect(page.getByRole('alert')).toContainText('Previous results are shown.');
        await expect(page.getByRole('button', { name: /New public expedition/ })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('stale-public-expeditions.png'), fullPage: true });

        unavailable = false;
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(page.getByText('Could not refresh public expeditions.', { exact: false })).toHaveCount(0);
        entries = [];
        await page.clock.fastForward(30_000);
        await expect(page.getByRole('button', { name: /New public expedition/ })).toHaveCount(0);
        await expect(page.getByText('No public expeditions found.')).toBeVisible();
        await expect(page.getByRole('region', { name: 'Expedition hosting' }).getByText('room-1', { exact: true }))
            .toBeVisible();
        await expect(page.getByRole('button', { name: '✓ Ready', exact: true })).toBeDisabled();
        await page.screenshot({ path: testInfo.outputPath('automatic-directory-recovered.png'), fullPage: true });
    }
);

function publicExpedition(): GroupDirectoryEntry {
    return {
        groupRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'new-public-room' },
        displayName: 'Relic Hunters: New public expedition',
        kind: 'room',
        joinMode: 'open',
        memberCount: 1,
        onlineMemberCount: 1,
        maxMembers: 4,
        isFull: false,
        lifecycleState: 'active',
        peerRttMs: null
    };
}
