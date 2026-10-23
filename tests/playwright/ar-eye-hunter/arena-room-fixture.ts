import {
    test,
    type Page
} from '@playwright/test';

interface ArenaRoomFixtures {
    readonly guest: Page;
}

export const arenaRoomTest = test.extend<ArenaRoomFixtures>({
    guest: async ({ browser }, use) => {
        // Separate browsers keep the two active arenas from sharing one software graphics process.
        const guestBrowser = await browser.browserType().launch();
        try {
            const guestContext = await guestBrowser.newContext();
            try {
                await use(await guestContext.newPage());
            }
            finally {
                // Playwright exports failure traces and screenshots when the context closes.
                await guestContext.close();
            }
        }
        finally {
            await guestBrowser.close();
        }
    }
});
