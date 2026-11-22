import { expect } from '@playwright/test';
import { openArenaOperations, toGroupId } from '../room-player-journey.ts';
import { signInIdleSocialPlayers } from '../sign-in-idle-social-players.ts';
import { matchmakingExpiryJourney, matchmakingPlayJourney } from '../matchmaking-journey.ts';
import { partyPlayJourney } from '../party-play-journey.ts';
import { roomBrowserTest } from '../room-browser-fixture.ts';

roomBrowserTest(
    'find players, recover, decline, confirm and play together through visible controls',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240000);
        await matchmakingPlayJourney(page, guest, 'arena');
    }
);

roomBrowserTest(
    'retry a lost response, expire searches and confirmations, and explicitly search again',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240000);
        await matchmakingExpiryJourney(page, guest, 'arena');
    }
);

roomBrowserTest(
    'party invitation, exact retry, recovery, move and repeat play together',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240000);
        await partyPlayJourney(page, guest, 'arena');
    }
);

roomBrowserTest('confirm a search from another arena and recover a missed match outcome', async ({ page, guest }) => {
    roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
    await signInIdleSocialPlayers(page, guest, 'arena');
    const find = page.getByRole('region', { name: 'Find players', exact: true });
    const other = guest.getByRole('region', { name: 'Find players', exact: true });
    const create = page.getByRole('button', { name: 'New unlisted arena', exact: true });
    const link = page.getByLabel('Room link', { exact: true });
    await create.click();
    await expect(link).toHaveValue(/#rallar-room\?/);
    const first = await link.inputValue();
    await find.getByRole('button', { name: 'Find a game', exact: true }).click();
    await expect(find).toContainText('Searching for players');
    await create.click();
    await expect(link).not.toHaveValue(first);
    await expect(link).toHaveValue(/#rallar-room\?/);
    const second = await link.inputValue();
    expect(toGroupId(second)).not.toBe(toGroupId(first));
    await other.getByRole('button', { name: 'Find a game', exact: true }).click();
    await find.getByRole('button', { name: 'Confirm match', exact: true }).click();
    await expect(find).toContainText('Waiting for the other players');
    await expect(link).toHaveValue(second);

    await page.goto('about:blank');
    await other.getByRole('button', { name: 'Confirm match', exact: true }).click();
    await expect(other).toContainText('Your group is ready');
    await page.goto(second);
    await openArenaOperations(page);
    await expect(find.getByRole('button', { name: 'Enter matched room', exact: true })).toBeEnabled();
    await expect(link).toHaveValue(second);
});
