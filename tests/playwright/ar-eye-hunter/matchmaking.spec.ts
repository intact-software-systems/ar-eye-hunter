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
