import { friendsPlayJourney } from '../friends-journey.ts';
import { roomBrowserTest } from '../room-browser-fixture.ts';

roomBrowserTest(
    'friends consent, private presence, invite, reload, shared play and block through visible controls',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240000);
        await friendsPlayJourney(page, guest, 'relic');
    }
);
