import type { Page } from '@playwright/test';

/** Use the browser timezone and canonical HTML datetime-local value, including whole minutes. */
export async function localStartInput(page: Page, delayMs: number) {
    return await page.evaluate((delay) => {
        const date = new Date(Math.ceil((Date.now() + delay) / 1000) * 1000);
        return {
            epochMs: date.getTime(),
            input: new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace(
                /:00$/,
                ''
            )
        };
    }, delayMs);
}
