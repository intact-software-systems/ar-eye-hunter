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
        const frozen = await page.getByLabel('Period clock').textContent();
        expect(frozen).toMatch(/^(2:[0-5][0-9]|3:00)$/);
        await expect(guest.locator('#phase')).toHaveText('Ready');
        await guest.getByRole('button', { name: 'Switch court' }).click();
        await guest.getByLabel('Room', { exact: true }).fill(court);
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        await expect(guest.getByLabel('Current period')).toHaveText('halftime');
        await expect(guest.getByLabel('Period clock')).toHaveText(frozen!);
        await expect(guest.getByRole('button', { name: 'Resume' })).toBeDisabled();
        // A scoreboard has no director relay. Its referee may resume after relay heartbeats would be stale.
        const sdkUrl = '/@fs' + fileURLToPath(new URL('../../../packages/shared-web/browser/rallar.ts', import.meta.url));
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
