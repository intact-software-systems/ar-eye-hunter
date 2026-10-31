import {
    moveConsentRecoveryJourney,
    moveLeavesSpectatorJourney,
    moveTogetherJourney
} from '../move-together-journey.ts';
import { roomBrowserTest } from '../room-browser-fixture.ts';
roomBrowserTest(
    'moves two consenting hunters together, retains away memberships and explicitly joins the expedition',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the local Relic server.');
        roomBrowserTest.setTimeout(240000);
        await moveTogetherJourney(page, guest, 'relic');
    }
);

roomBrowserTest(
    'invalidates consent after reload and organizer departure, and expires a waiting move',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the local Relic server.');
        roomBrowserTest.setTimeout(240000);
        await moveConsentRecoveryJourney(page, guest, 'relic');
    }
);

roomBrowserTest('moves consenting players while spectators stay in the source room', async ({ page, guest }) => {
    roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the local API and built SPA.');
    await moveLeavesSpectatorJourney(page, guest, 'relic');
});
