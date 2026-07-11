import { expect, test } from '@playwright/test';

test('pairs every operational status with text and shape', async ({ page }) => {
    await page.goto('/test/fixtures/recipe-console-css-isolation.html?mode=recipe-console');
    for (const status of ['running', 'passed', 'failed', 'warning', 'stale', 'partial', 'disabled']) {
        const mark = page.locator(`[data-status="${status}"]`);
        await expect(mark).toContainText(new RegExp(status, 'i'));
        await expect(mark.locator('[data-status-shape]')).toHaveCount(1);
        await expect(mark.locator('[data-status-shape]')).not.toHaveAttribute('data-shape', 'dot');
    }
});
