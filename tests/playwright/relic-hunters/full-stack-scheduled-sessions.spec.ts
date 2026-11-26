import { roomBrowserTest } from '../room-browser-fixture.ts';
import { guestSessionBookingJourney, scheduledSessionPlayJourney, scheduledSessionRecoveryJourney } from '../scheduled-session-journey.ts';

roomBrowserTest(
    'schedules, reserves, reloads, reconfirms and cancels an expedition session through visible controls',
    async ({ page, guest }) => {
        roomBrowserTest.skip(
            process.env.RELIC_HUNTERS_FULL_STACK !== '1',
            'Requires the actual API, Relic server and SPA.'
        );
        roomBrowserTest.setTimeout(240_000);
        await scheduledSessionRecoveryJourney(page, guest, 'relic');
    }
);

roomBrowserTest(
    'claims scheduled seats, starts explicitly and completes a shared expedition round',
    async ({ page, guest }) => {
        roomBrowserTest.skip(
            process.env.RELIC_HUNTERS_FULL_STACK !== '1',
            'Requires the actual API, Relic server and SPA.'
        );
        roomBrowserTest.setTimeout(240_000);
        await scheduledSessionPlayJourney(page, guest, 'relic');
    }
);

roomBrowserTest('a guest recovers a booking after a lost response and enters the expedition lobby',
    async ({ page, guest, browser }) => {
        roomBrowserTest.skip(process.env.RELIC_HUNTERS_FULL_STACK !== '1', 'Requires the actual API, Relic server and SPA.');
        roomBrowserTest.setTimeout(180_000);
        await guestSessionBookingJourney(page, guest, browser, 'relic');
    });
