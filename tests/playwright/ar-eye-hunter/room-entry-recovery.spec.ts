import { roomBrowserTest } from '../room-browser-fixture.ts';
import { roomEntryRecoveryJourney } from '../room-entry-recovery-journey.ts';

roomBrowserTest(
    'recovers committed room entry after a lost response and plays together after reload',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local server and built SPA.');
        await roomEntryRecoveryJourney(page, guest, 'arena');
    }
);
