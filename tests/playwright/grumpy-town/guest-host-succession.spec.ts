import { expect, test } from '@playwright/test';
import { registerPlayer } from './match-browser.ts';

test('two invited guests can take over and play a rematch after their host disconnects', async ({ browser }) => {
    test.setTimeout(420_000);
    const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()));
    const [owner, ...guests] = await Promise.all(contexts.map(context => context.newPage()));
    try {
        await registerPlayer(owner, 'town-owner-' + crypto.randomUUID());
        await owner.getByRole('button', { name: 'Create town', exact: true }).click();
        await owner.getByRole('button', { name: 'Host match', exact: true }).click();
        await owner.getByRole('button', { name: 'Invite guests' }).click();
        const invitation = await owner.getByLabel('Guest invitation link').inputValue();
        for (const guest of guests) {
            await guest.goto(invitation);
            await guest.getByRole('button', { name: 'Join this town' }).click();
            await expect(guest.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 25_000 });
            await guest.getByRole('button', { name: 'Ready', exact: true }).click();
        }
        await owner.getByRole('button', { name: 'Ready', exact: true }).click();
        await expect(owner.locator('#match-controls')).toContainText('3/3 ready', { timeout: 20_000 });
        await owner.getByRole('button', { name: 'Start round' }).click();
        for (const guest of guests) {
            await expect(guest.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 25_000 });
        }
        const original = await owner.locator('#online-game').getAttribute('data-match-id');
        await contexts[0].close();
        const isHost = async () => Promise.all(guests.map(guest => guest.locator('#online-game').getAttribute('data-director')));
        await expect.poll(async () => (await isHost()).filter(value => value === 'true').length, { timeout: 100_000 }).toBe(1);
        const hostIndex = (await isHost()).indexOf('true');
        const host = guests[hostIndex];
        const friend = guests[1 - hostIndex];
        await expect(host.locator('#online-game')).toHaveAttribute('data-match-id', original!);
        await expect(host.getByRole('button', { name: /Invite guests|Replace invitation/ })).toHaveCount(0);
        await expect(host.getByLabel('Guest invitation link')).toHaveCount(0);
        await expect(host.getByRole('button', { name: 'New round' })).toBeVisible({ timeout: 240_000 });
        await expect(friend.getByRole('button', { name: 'New round' })).toBeHidden();
        await host.getByRole('button', { name: 'New round' }).click();
        for (const guest of guests) {
            await guest.getByRole('button', { name: 'Ready', exact: true }).click();
        }
        await expect(host.locator('#match-controls')).toContainText('2/2 ready', { timeout: 20_000 });
        await host.getByRole('button', { name: 'Start round' }).click();
        for (const guest of guests) {
            await expect(guest.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 25_000 });
            await expect(guest.locator('#online-game')).not.toHaveAttribute('data-match-id', original!);
            await expect(guest.getByRole('button', { name: 'Dash and drop' })).toBeEnabled();
        }
        expect(await host.locator('#online-game').getAttribute('data-match-id')).toBe(await friend.locator('#online-game').getAttribute('data-match-id'));
    } finally {
        await Promise.all(contexts.map(context => context.close()));
    }
});
