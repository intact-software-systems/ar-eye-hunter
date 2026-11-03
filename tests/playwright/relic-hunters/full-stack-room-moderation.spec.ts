import { roomBrowserTest } from '../room-browser-fixture.ts';
import { roomModerationJourney } from '../room-moderation-journey.ts';

roomBrowserTest(
    'moderates room access and recovers affected players through visible controls',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        // The hosted two-player journey reached final recovery at 131s; keep each assertion's existing deadline.
        roomBrowserTest.setTimeout(180_000);
        await roomModerationJourney(page, guest, 'relic');
    }
);
