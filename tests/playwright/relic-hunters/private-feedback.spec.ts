import { expect, test } from '@playwright/test';

import {
    createGroupSnapshot,
    initBrowserTestTransport,
    startRelicBrowserBackend
} from './relic-browser-backend.ts';
import { createFinishedRelicSnapshot, createRelicSnapshotWithPlayers } from './relic-browser-snapshots.ts';

test('dismisses a refused plan when another hunter advances the expedition to the finale', async ({ page }) => {
    await initBrowserTestTransport(page);
    const refusal = 'Review the revealed actions before planning the next turn.';
    const backend = await startRelicBrowserBackend(page, {
        rooms: [createGroupSnapshot({ onlineMemberCount: 2 })],
        relicSnapshot: createRelicSnapshotWithPlayers(2, 'planning'),
        commandRefusal: refusal
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Register' }).click();
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('Display name').fill('Alice');
    await page.getByLabel('Password').fill('test-only-password');
    await page.getByRole('button', { name: 'Create Hunter' }).click();
    await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();
    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
    await page.getByRole('button', { name: 'Submit Plan' }).click();
    await expect(page.getByText(refusal, { exact: true })).toBeVisible();
    backend.publishSnapshot(createFinishedRelicSnapshot());
    await expect(page.getByLabel('Current turn summary').getByText('Expedition complete', { exact: true }))
        .toBeVisible();
    await expect(page.getByText(refusal, { exact: true })).toHaveCount(0);
});
