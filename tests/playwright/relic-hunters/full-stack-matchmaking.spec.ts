import { matchmakingExpiryJourney, matchmakingPlayJourney } from '../matchmaking-journey.ts';
import { partyPlayJourney } from '../party-journey.ts';
import { roomBrowserTest } from '../room-browser-fixture.ts';

roomBrowserTest(
    'find players, recover, decline, confirm and play together through visible controls',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240000);
        await matchmakingPlayJourney(page, guest, 'relic');
    }
);

roomBrowserTest(
    'retry a lost response, expire searches and confirmations, and explicitly search again',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240000);
        await matchmakingExpiryJourney(page, guest, 'relic');
    }
);

roomBrowserTest(
    'party invitation, exact retry, recovery, move and repeat play together',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240000);
        await partyPlayJourney(page, guest, 'relic');
    }
);
