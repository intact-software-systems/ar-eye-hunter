import { expect, test } from '@playwright/test';

test('keeps representative legacy and recipe console styles isolated', async ({ page }) => {
    await page.goto('/test/fixtures/recipe-console-css-isolation.html?mode=both');

    const recipeSurface = page.locator('[data-isolation-recipe-surface]');
    const legacyPanel = page.locator('[data-isolation-legacy-panel]');
    await expect(recipeSurface).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(recipeSurface).toHaveCSS('border-top-color', 'rgb(213, 219, 227)');
    await expect(legacyPanel).toHaveClass(/panel/);
    await expect(legacyPanel).not.toHaveCSS('background-color', 'rgb(245, 247, 250)');

    const recipeButton = page.locator('[data-isolation-recipe-button]');
    await expect(recipeButton).toHaveCSS('background-color', 'rgb(36, 70, 194)');
    await expect(recipeButton).toHaveCSS('border-radius', '6px');
});
