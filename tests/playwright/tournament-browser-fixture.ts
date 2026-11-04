import type { Page } from '@playwright/test';
import { roomBrowserTest, useIsolatedRoomPage } from './room-browser-fixture.ts';

interface TournamentBrowserFixtures {
    readonly third: Page;
    readonly fourth: Page;
    readonly players: readonly [Page, Page, Page, Page];
}

export const tournamentBrowserTest = roomBrowserTest.extend<TournamentBrowserFixtures>({
    third: async ({ browser }, use, testInfo) => {
        await useIsolatedRoomPage(browser, use, testInfo, 'third', { hasTouch: true });
    },
    fourth: async ({ browser }, use, testInfo) => {
        await useIsolatedRoomPage(browser, use, testInfo, 'fourth', { hasTouch: true });
    },
    players: async ({ page, guest, third, fourth }, use) => {
        await use([page, guest, third, fourth]);
    }
});
