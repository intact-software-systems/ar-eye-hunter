import {
    test,
    type Page
} from '@playwright/test';

interface RoomBrowserFixtures {
    readonly guest: Page;
}

export const roomBrowserTest = test.extend<RoomBrowserFixtures>({
    guest: async ({ browser }, use) => {
        // Separate browsers keep active game scenes from sharing one software graphics process.
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
