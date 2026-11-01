import { roomBrowserTest } from '../room-browser-fixture.ts';
import { scheduledSessionPlayJourney, scheduledSessionRecoveryJourney } from '../scheduled-session-journey.ts';

roomBrowserTest(
    'schedules, reserves, reloads, reconfirms and cancels an arena session through visible controls',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240_000);
        await scheduledSessionRecoveryJourney(page, guest, 'arena');
    }
);

roomBrowserTest(
    'claims scheduled seats and plays together after the host explicitly starts',
    async ({ page, guest }) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the actual API and built SPA.');
        roomBrowserTest.setTimeout(240_000);
        await scheduledSessionPlayJourney(page, guest, 'arena');
    }
);
