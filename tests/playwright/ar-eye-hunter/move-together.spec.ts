import {
    moveConsentRecoveryJourney,
    moveLeavesSpectatorJourney,
    moveTogetherJourney
} from '../move-together-journey.ts';
import { roomBrowserTest } from '../room-browser-fixture.ts';
roomBrowserTest(
    'moves two consenting players together, retains away memberships and starts gameplay',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API and built SPA.');
        await moveTogetherJourney(page, guest, 'arena');
    }
);

roomBrowserTest(
    'invalidates consent after reload and organizer departure, and expires a waiting move',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API and built SPA.');
        roomBrowserTest.setTimeout(240000);
        await moveConsentRecoveryJourney(page, guest, 'arena');
    }
);

roomBrowserTest('moves consenting players while spectators stay in the source room', async ({ page, guest }) => {
    roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API and built SPA.');
    await moveLeavesSpectatorJourney(page, guest, 'arena');
});
