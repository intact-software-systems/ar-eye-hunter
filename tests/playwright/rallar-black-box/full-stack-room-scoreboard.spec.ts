import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFullStackConfig } from './full-stack-helpers.ts';

const config = readFullStackConfig();
const url = '/@fs' + fileURLToPath(new URL('../../../examples/room-scoreboard/index.html', import.meta.url));

test('a returning participant recovers halftime and its paused clock together after visiting another court', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const otherCourtOwner = await browser.newPage({ baseURL });
    const court = 'court-' + crypto.randomUUID();
    try {
        for (const [screen, user, action, groupId] of [
            [otherCourtOwner, config.userA, 'Create room', court + '-other'],
            [page, config.userA, 'Create room', court],
            [guest, config.userB, 'Enter room', court]
        ] as const) {
            await screen.goto(url);
            await screen.getByLabel('Username').fill(user.username);
            await screen.getByLabel('Password').fill(user.password);
            await screen.getByLabel('Room', { exact: true }).fill(groupId);
            await screen.getByRole('button', { name: action }).click();
            await expect(screen.getByRole('heading', { name: groupId, exact: true })).toBeVisible();
        }
        await page.getByRole('button', { name: 'Take clock control' }).click();
        await page.getByRole('button', { name: 'Start 10 minutes' }).click();
        await expect(guest.locator('#phase')).toHaveText('Running');
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court + '-other');
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.locator('#phase')).toHaveText('Ready');
        await page.getByRole('button', { name: 'Advance to halftime' }).click();
        await expect(page.getByLabel('Current period')).toHaveText('halftime');
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(page.locator('#phase')).toHaveText('Paused');
        const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
        const balance = await page.evaluate(async ({ sdkUrl, court }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
            const before = await rallar.rooms.readTimeline(room, 'match');
            if (before?.status !== 'paused') throw new Error('Expected paused halftime');
            const extension = { name: 'match', durationMs: 30_000, expectedRevision: before.revision,
                expectedDirectorEpoch: rallar.director.status(room).appointment!.epoch };
            const requestId = crypto.randomUUID();
            const accepted = await rallar.rooms.extendTimeline(room, extension, requestId);
            const replay = await rallar.rooms.extendTimeline(room, extension, requestId);
            return { before, accepted, replay };
        }, { sdkUrl, court });
        expect(balance.before.remainingMs).toBeGreaterThanOrEqual(120_000);
        expect(balance.before.remainingMs).toBeLessThanOrEqual(180_000);
        const updated = { ...balance.before, revision: balance.before.revision + 1, remainingMs: balance.before.remainingMs + 30_000 };
        expect(balance.accepted).toEqual(updated);
        expect(balance.replay).toEqual(updated);
        await expect(guest.locator('#phase')).toHaveText('Ready');
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court);
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        await expect(guest.getByLabel('Current period')).toHaveText('halftime');
        const recovered = await guest.evaluate(async ({ sdkUrl, court }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            return rallar.rooms.readTimeline({ applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court }, 'match');
        }, { sdkUrl, court });
        expect(recovered).toEqual(updated);
        const seconds = Math.ceil(updated.remainingMs / 1000);
        await expect(guest.getByLabel('Period clock')).toHaveText(Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'));
        await expect(guest.getByRole('button', { name: 'Resume' })).toBeDisabled();
        // A scoreboard has no director relay. Its referee may resume after relay heartbeats would be stale.
        await expect.poll(() => page.evaluate(async ({ sdkUrl, court }) => {
            const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
            const director = rallar.director.status({ applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court });
            return director.active && director.isDirector && !director.isFresh;
        }, { sdkUrl, court }), { timeout: 30_000 }).toBe(true);
        await page.getByRole('button', { name: 'Resume' }).click();
        await expect(guest.locator('#phase')).toHaveText('Running');
    }
    finally {
        await Promise.all([guest.close(), otherCourtOwner.close()]);
    }
});

test('a director can recover a clock-only court and explicitly advance its existing clock', async ({ page }) => {
    test.skip(!config.enabled, config.skipReason);
    const court = 'court-' + crypto.randomUUID();
    await page.goto(url);
    await page.getByLabel('Username').fill(config.userA.username);
    await page.getByLabel('Password').fill(config.userA.password);
    await page.getByLabel('Room', { exact: true }).fill(court);
    await page.getByRole('button', { name: 'Create room' }).click();
    await page.getByRole('button', { name: 'Take clock control' }).click();
    await expect(page.getByRole('button', { name: 'Start 10 minutes' })).toBeEnabled();
    const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
    const remainingMs = await page.evaluate(async ({ sdkUrl, court }) => {
        const { rallar }: typeof import('@shared-web/browser/rallar.ts') = await import(sdkUrl);
        const room = { applicationId: 'room-scoreboard', workspaceId: 'default', groupId: court };
        const expectedDirectorEpoch = rallar.director.status(room).appointment!.epoch;
        const command = { name: 'match', expectedDirectorEpoch };
        await rallar.rooms.changeClock(room, { ...command, operation: 'start', expectedRevision: 0, durationMs: 90_000 }, crypto.randomUUID());
        const paused = await rallar.rooms.changeClock(room, { ...command, operation: 'pause', expectedRevision: 1 }, crypto.randomUUID());
        if (paused.status !== 'paused') throw new Error('Expected a paused clock');
        return paused.remainingMs;
    }, { sdkUrl, court });
    await page.getByRole('button', { name: 'Switch court' }).click();
    await page.getByRole('button', { name: 'Enter room' }).click();
    await expect(page.locator('#phase')).toHaveText('Paused');
    const seconds = Math.ceil(remainingMs / 1000);
    await expect(page.getByLabel('Period clock')).toHaveText(Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'));
    await page.getByRole('button', { name: 'Advance to halftime' }).click();
    await expect(page.getByLabel('Current period')).toHaveText('halftime');
    await expect(page.locator('#phase')).toHaveText('Running');
});
