import type { Page } from '@playwright/test';
import { roomBrowserTest } from './room-browser-fixture.ts';

interface TournamentBrowserFixtures {
    readonly players: readonly [Page, Page, Page, Page];
}

export const tournamentBrowserTest = roomBrowserTest.extend<TournamentBrowserFixtures>({
    players: async ({ page, guest, browser }, use) => {
        // Each live 3D player gets its own graphics process, like the guest fixture.
        const third = await browser.browserType().launch();
        try {
            const fourth = await browser.browserType().launch();
            try {
                await use([
                    page,
                    guest,
                    await third.newPage({ hasTouch: true }),
                    await fourth.newPage({ hasTouch: true })
                ]);
            }
            finally {
                await fourth.close();
            }
        }
        finally {
            await third.close();
        }
    }
});
