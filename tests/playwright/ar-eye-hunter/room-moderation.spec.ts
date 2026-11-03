import { roomBrowserTest } from '../room-browser-fixture.ts';
import { roomModerationJourney } from '../room-moderation-journey.ts';

roomBrowserTest(
    'moderates room access and recovers affected players through visible controls',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        await roomModerationJourney(page, guest, 'arena');
    }
);
