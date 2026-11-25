import { expect, test } from '@playwright/test';
import { registerPlayer } from './match-browser.ts';

test('a fifth player sees a full town and can take the released seat with a fresh invitation', async ({ page: owner, browser }) => {
    test.setTimeout(60_000);
    await registerPlayer(owner, 'town-owner-' + crypto.randomUUID());
    await owner.getByRole('button', { name: 'Create town', exact: true }).click();
    await owner.getByRole('button', { name: 'Invite guests' }).click();
    const link = owner.getByLabel('Guest invitation link');
    const original = await link.inputValue();
    const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
    try {
        const guests = await Promise.all(contexts.map(context => context.newPage()));
        for (const guest of guests.slice(0, 3)) {
            await guest.goto(original);
            await guest.getByRole('button', { name: 'Join this town' }).click();
            await expect(guest.getByRole('heading', { name: 'Your town lobby' })).toBeVisible();
        }
        const waiting = guests[3];
        await waiting.goto(original);
        await waiting.getByRole('button', { name: 'Join this town' }).click();
        await expect(waiting.getByRole('alert')).toContainText('Town is full');
        await expect(owner.locator('#roster li')).toHaveCount(4);
        await owner.getByRole('button', { name: 'Remove guest' }).first().click();
        await expect(owner.locator('#roster li')).toHaveCount(3);
        await owner.getByRole('button', { name: 'Invite guests' }).click();
        await expect(link).not.toHaveValue(original);
        await waiting.goto(await link.inputValue());
        await waiting.getByRole('button', { name: 'Join this town' }).click();
        await expect(waiting.getByRole('heading', { name: 'Your town lobby' })).toBeVisible();
        await expect(owner.locator('#roster li')).toHaveCount(4);
    } finally {
        await Promise.all(contexts.map(context => context.close()));
    }
});
