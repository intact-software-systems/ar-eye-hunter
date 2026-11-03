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
                const thirdContext = await third.newContext({ hasTouch: true });
                const fourthContext = await fourth.newContext({ hasTouch: true });
                try {
                    await use([page, guest, await thirdContext.newPage(), await fourthContext.newPage()]);
                }
                finally {
                    await Promise.all([thirdContext.close(), fourthContext.close()]);
                }
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
