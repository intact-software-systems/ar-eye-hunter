import { expect, test } from '@playwright/test';

test('keeps one lazy experience mounted', async ({ page }) => {
    await page.goto('/?provider=simulated');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);

    await page.evaluate(() => {
        history.pushState({}, '', '/?provider=simulated&experience=recipe-console');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.recipe-console')).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);

    await page.evaluate(() => {
        history.pushState({}, '', '/?provider=simulated&tab=monitor');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);
});
