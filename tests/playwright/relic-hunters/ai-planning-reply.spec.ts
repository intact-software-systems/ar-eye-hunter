import { expect, test, type Page } from '@playwright/test';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { RELIC_TYPES, type RelicCommand } from '../../../packages/relic-hunters/mod.ts';
import { createGroupSnapshot, initBrowserTestTransport, startRelicBrowserBackend } from './relic-browser-backend.ts';
import { createRelicSnapshotWithPlayers } from './relic-browser-snapshots.ts';

const SERVER_HEADLINE = 'The server companion says: take this route';

test('shows the server companion\'s reply to the asking hunter and still submits the plan the hunter primed', async ({ page }) => {
    const commandBodies: RelicCommand[] = [];
    const receivedFrames: ALMessage[] = [];
    await startPlanningExpedition(page, { commandBodies, receivedFrames, planningReplyHeadline: SERVER_HEADLINE });

    await page.locator('#hud-ai').getByRole('button', { name: 'Ask' }).click();

    await expect(page.locator('#hud-ai').getByText(SERVER_HEADLINE, { exact: true })).toBeVisible();
    expect(receivedFrames.filter((frame) => frame.payload.typeId === RELIC_TYPES.aiPlanningRequest)).toHaveLength(1);
    await page.locator('#hud-ai').getByRole('button', { name: 'Prime' }).click();
    await page.getByRole('button', { name: 'Submit Plan' }).click();
    await expect.poll(() => commandBodies.map((command) => command.kind)).toContain('submit-action');
});

test('answers with the local companion once the silent server lets the reply time out', async ({ page }) => {
    const receivedFrames: ALMessage[] = [];
    await startPlanningExpedition(page, { receivedFrames });

    await page.locator('#hud-ai').getByRole('button', { name: 'Ask' }).click();

    await expect(page.locator('#hud-ai .relic-ai-card.local')).toBeVisible({ timeout: 10_000 });
    expect(receivedFrames.filter((frame) => frame.payload.typeId === RELIC_TYPES.aiPlanningRequest)).toHaveLength(1);
    await expect(page.locator('#hud-ai').getByText(SERVER_HEADLINE, { exact: true })).toHaveCount(0);
});

async function startPlanningExpedition(
    page: Page,
    options: Readonly<{ commandBodies?: RelicCommand[]; receivedFrames: ALMessage[]; planningReplyHeadline?: string; }>
): Promise<void> {
    await initBrowserTestTransport(page);
    await startRelicBrowserBackend(page, {
        rooms: [createGroupSnapshot({ onlineMemberCount: 1 })],
        relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning'),
        ...options
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Register' }).click();
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('Display name').fill('Alice');
    await page.getByLabel('Password').fill('test-only-password');
    await page.getByRole('button', { name: 'Create Hunter' }).click();
    await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();
    await expect(page.locator('#hud-ai').getByRole('button', { name: 'Ask' })).toBeEnabled();
}
