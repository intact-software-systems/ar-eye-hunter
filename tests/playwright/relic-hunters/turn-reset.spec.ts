import {
    expect,
    test,
    type Page
} from '@playwright/test';

import type { RelicCommand } from '../../../packages/relic-hunters/mod.ts';
import {
    createGroupSnapshot,
    initBrowserTestTransport,
    startRelicBrowserBackend
} from './relic-browser-backend.ts';
import { createRelicSnapshotWithPlayers } from './relic-browser-snapshots.ts';

test('preserves an ordinary draft but clears selections and old locked action for a new expedition', async ({ page }) => {
    const snapshot = createRelicSnapshotWithPlayers(2, 'planning');
    const backend = await startRelicBrowserBackend(page, {
        rooms: [createGroupSnapshot({ onlineMemberCount: 2 })],
        relicSnapshot: snapshot,
        commandSnapshot: {
            ...snapshot,
            updatedAtEpochMs: snapshot.updatedAtEpochMs + 2,
            submittedPlayerIds: ['alice-session']
        }
    });
    await enterExpedition(page);
    await page.getByLabel('Castle room map').getByRole('button', { name: 'Hallway', exact: true }).click();
    await page.getByRole('button', { name: 'Prime Move → Hallway' }).click();
    const move = page.locator('.action-picker').getByRole('button', { name: /^Move/ });
    await expect(move).toHaveAttribute('aria-pressed', 'true');
    backend.publishSnapshot({
        ...snapshot,
        updatedAtEpochMs: snapshot.updatedAtEpochMs + 1,
        submittedPlayerIds: ['bob-session']
    });
    await expect(page.locator('.turn-plan-counters')).toContainText('1 locked');
    await expect(move).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Submit Plan' }).click();
    await expect(page.locator('.locked-action-label')).toContainText('Hallway');

    backend.publishSnapshot({
        ...snapshot,
        createdAtEpochMs: 2,
        updatedAtEpochMs: snapshot.updatedAtEpochMs + 3,
        submittedPlayerIds: ['alice-session']
    });
    await expect(page.locator('.locked-action-label')).toHaveText('Plan submitted');
    await expect(page.locator('.action-picker').getByRole('button', { name: /^Search/ }))
        .toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Prime Move → Hallway' })).toHaveCount(0);
});

test('keeps the chosen draft when Reset is refused', async ({ page }) => {
    await startRelicBrowserBackend(page, {
        rooms: [createGroupSnapshot({ onlineMemberCount: 2 })],
        relicSnapshot: createRelicSnapshotWithPlayers(2, 'planning')
    });
    await page.route(
        '**/api/relic/games/*/reset/requests/*',
        (route) => route.fulfill({ status: 403, json: { error: 'Reset refused' } })
    );
    await enterExpedition(page);
    const move = page.locator('.action-picker').getByRole('button', { name: /^Move/ });
    await move.click();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page.locator('.error-panel')).toContainText('Failed to reset expedition: 403');
    await expect(move).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
});

test('automatically submits the reused round once in each expedition', async ({ page }) => {
    const now = Date.now();
    await page.clock.install({ time: now });
    let snapshot = createRelicSnapshotWithPlayers(2, 'planning', { roundTimeLimitMs: 1_000 });
    const commands: RelicCommand[] = [];
    const backend = await startRelicBrowserBackend(page, {
        rooms: [createGroupSnapshot({ onlineMemberCount: 2 })],
        relicSnapshot: snapshot,
        commandBodies: commands,
        commandResponse: () => snapshot
    });
    await enterExpedition(page);
    await page.locator('.action-picker').getByRole('button', { name: /^Search/ }).click();
    snapshot = {
        ...snapshot,
        updatedAtEpochMs: snapshot.updatedAtEpochMs + 1,
        roundStartedAtEpochMs: await page.evaluate(() => Date.now()) + 1_000
    };
    backend.publishSnapshot(snapshot);
    await expect(page.locator('.round-timer strong')).not.toHaveText('0:00');
    await page.clock.fastForward(3_000);
    await expect.poll(() => commands.filter((command) => command.kind === 'submit-action')).toHaveLength(1);
    await page.clock.runFor(1_000);
    expect(commands.filter((command) => command.kind === 'submit-action')).toHaveLength(1);

    snapshot = {
        ...snapshot,
        createdAtEpochMs: 2,
        updatedAtEpochMs: snapshot.updatedAtEpochMs + 1,
        roundStartedAtEpochMs: await page.evaluate(() => Date.now()) + 1_000
    };
    backend.publishSnapshot(snapshot);
    await expect(page.locator('.round-timer strong')).not.toHaveText('0:00');
    await page.clock.fastForward(3_000);
    await expect.poll(() => commands.filter((command) => command.kind === 'submit-action')).toHaveLength(2);
    await page.clock.runFor(1_000);
    expect(commands.filter((command) => command.kind === 'submit-action')).toHaveLength(2);
    expect(commands.filter((command) => command.kind === 'submit-action').map((command) => command.action))
        .toEqual([{ kind: 'search' }, { kind: 'search' }]);
});

async function enterExpedition(page: Page): Promise<void> {
    await initBrowserTestTransport(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Register' }).click();
    await page.getByLabel('Username', { exact: true }).fill('alice');
    await page.getByLabel('Display name', { exact: true }).fill('Alice');
    await page.getByLabel('Password', { exact: true }).fill('test-only-password');
    await page.getByRole('button', { name: 'Create Hunter' }).click();
    await page.getByRole('button', { name: /^Relic Hunters Expedition/ }).click();
    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
}
