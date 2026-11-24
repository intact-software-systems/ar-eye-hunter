import { expect, test } from '@playwright/test';

test.use({ browserName: 'webkit', isMobile: true, hasTouch: true, launchOptions: { args: [] } });

test('WebKit gesture defaults are canceled while playing and available again in the lobby', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-zoom', '13.00');
    const gestureAllowed = (selector: string, type: string) =>
        page.locator(selector).evaluate((target, type) => target.dispatchEvent(
            new Event(type, { bubbles: true, cancelable: true })
        ), type);

    for (const target of ['canvas', '#zoom-in', '#dash']) {
        for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
            expect(await gestureAllowed(target, type)).toBe(false);
        }
    }
    await page.getByRole('button', { name: 'Zoom out' }).tap();
    await expect(page.locator('#app')).toHaveAttribute('data-zoom', '15.00');
    await page.getByRole('button', { name: 'Play with friends' }).tap();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
    expect(await gestureAllowed('main', 'gesturestart')).toBe(true);
});

test('a tight WebKit pinch can reverse, lift one finger, cancel and start again', async ({ page }) => {
    await page.goto('/');
    const game = page.locator('#app');
    await expect(game).toHaveAttribute('data-zoom', '13.00');
    // Playwright WebKit offers native tap only. Feed the public touch-event sequence, including partial lifts.
    const contacts = (type: string, positions: number[]) => page.locator('canvas').evaluate((canvas, input) => {
        const event = new Event(input.type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: input.positions.map((x) => ({
            target: canvas, clientX: x, clientY: 300
        })) });
        return canvas.dispatchEvent(event);
    }, { type, positions });
    expect(await contacts('touchstart', [150])).toBe(true);
    expect(await contacts('touchstart', [150, 160])).toBe(false);
    await contacts('touchmove', [150, 190]);
    await expect(game).toHaveAttribute('data-zoom', '8.00');
    await contacts('touchend', [190]);
    await contacts('touchstart', [190, 290]);
    await contacts('touchmove', [190, 240]);
    await expect(game).toHaveAttribute('data-zoom', '16.00');
    await contacts('touchcancel', []);
    await contacts('touchstart', [100, 180]);
    await contacts('touchmove', [100, 260]);
    await expect(game).toHaveAttribute('data-zoom', '8.00');
    await contacts('touchend', []);
});
