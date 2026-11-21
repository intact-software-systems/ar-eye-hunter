import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFullStackConfig } from './full-stack-helpers.ts';

const config = readFullStackConfig();
const url = '/@fs' + fileURLToPath(new URL('../../../examples/room-scoreboard/index.html', import.meta.url));

test('a scoreboard receives pause live and recovers the frozen balance after visiting another court', async ({ page, browser, baseURL }) => {
    test.skip(!config.enabled, config.skipReason);
    const guest = await browser.newPage({ baseURL });
    const court = 'court-' + crypto.randomUUID();
    try {
        for (
            const [screen, user, action] of [[page, config.userA, 'Create room'], [
                guest,
                config.userB,
                'Enter room'
            ]] as const
        ) {
            await screen.goto(url);
            await screen.getByLabel('Username').fill(user.username);
            await screen.getByLabel('Password').fill(user.password);
            await screen.getByLabel('Room', { exact: true }).fill(court);
            await screen.getByRole('button', { name: action }).click();
            await expect(screen.getByRole('heading', { name: court })).toBeVisible();
        }
        await page.getByRole('button', { name: 'Take clock control' }).click();
        await page.getByRole('button', { name: 'Start 10 minutes' }).click();
        await expect(guest.locator('#phase')).toHaveText('Running');
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        const frozen = await guest.getByLabel('Period clock').textContent();
        await guest.reload();
        await guest.getByLabel('Room', { exact: true }).fill(court + '-other');
        await guest.getByRole('button', { name: 'Create room' }).click();
        await expect(guest.locator('#phase')).toHaveText('Ready');
        await guest.reload();
        await guest.getByLabel('Room', { exact: true }).fill(court);
        await guest.getByRole('button', { name: 'Enter room' }).click();
        await expect(guest.locator('#phase')).toHaveText('Paused');
        await expect(guest.getByLabel('Period clock')).toHaveText(frozen!);
        await expect(guest.getByRole('button', { name: 'Resume' })).toBeDisabled();
        await page.getByRole('button', { name: 'Resume' }).click();
        await expect(guest.locator('#phase')).toHaveText('Running');
    }
    finally {
        await guest.close();
    }
});
