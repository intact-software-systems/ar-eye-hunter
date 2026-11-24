import { expect, test, type Page } from '@playwright/test';

import { startTownMatch } from './match-browser.ts';

test.use({ isMobile: true, hasTouch: true });
test.skip(({ browserName }) => browserName !== 'chromium', 'Native multitouch injection uses Chromium DevTools.');

async function checkArenaPinch(page: Page, state: string): Promise<void> {
    const score = await page.locator('.scoreboard span').first().boundingBox();
    if (!score) throw new Error('Missing scoreboard');
    const x = Math.round(score.x + score.width / 2);
    const y = Math.round(score.y + score.height / 2);
    const controls = async () => ({
        stick: await page.locator('#joystick').boundingBox(),
        dash: await page.locator('#dash').boundingBox(),
        viewport: await page.evaluate(() => ({
            scale: window.visualViewport?.scale, x: window.visualViewport?.offsetLeft, y: window.visualViewport?.offsetTop
        }))
    });
    const before = await controls();
    expect(before.viewport).toEqual({ scale: 1, x: 0, y: 0 });
    const touch = await page.context().newCDPSession(page);
    const points = (span: number) => [{ id: 1, x, y }, { id: 2, x, y: y + span }];
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(120) });
    for (const span of [140, 160, 180, 200]) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(span) });
    }
    const camera = () => page.locator(state).getAttribute('data-zoom').then(Number);
    await expect.poll(camera).toBeGreaterThan(0);
    await expect.poll(camera).toBeLessThan(10);
    expect(await controls()).toEqual(before);
    for (const span of [170, 140, 110, 80]) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(span) });
    }
    await expect.poll(camera).toBeGreaterThan(16);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await controls()).toEqual(before);
    await page.screenshot({ path: test.info().outputPath('arena-after-pinch.png') });
}

test('solo phone pinch spanning the scoreboard zooms the camera with fixed controls', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-zoom', '13.00');
    await checkArenaPinch(page, '#app');
});

test('multiplayer phone pinch spanning the scoreboard zooms the camera with fixed controls', async ({ page, browser }) => {
    const owner = await browser.newPage();
    try {
        await startTownMatch([owner, page]);
        await checkArenaPinch(page, '#online-game');
    } finally {
        await owner.close();
    }
});
