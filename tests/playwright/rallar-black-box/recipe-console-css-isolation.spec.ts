import { expect, test } from '@playwright/test';

const legacySelectors = [
    '[data-isolation-legacy-panel]',
    '[data-isolation-legacy-pill]',
    '[data-isolation-legacy-metric]',
    '[data-isolation-legacy-form]',
    '[data-isolation-legacy-table]',
    '[data-isolation-legacy-dialog]',
] as const;
const recipeSelectors = [
    '[data-isolation-recipe-surface]',
    '[data-isolation-recipe-button]',
    '[data-isolation-recipe-status] [data-status="failed"]',
    '[data-isolation-recipe-form]',
    '[data-isolation-recipe-table]',
    '[data-isolation-recipe-dialog] [data-inspector-host]',
] as const;

async function capture(
    page: import('@playwright/test').Page,
    mode: string,
    selectors: readonly string[],
    fixture = '/test/fixtures/recipe-console-css-isolation.html',
) {
    const requests: string[] = [];
    const listener = (request: import('@playwright/test').Request) => requests.push(request.url());
    page.on('request', listener);
    await page.goto(`${fixture}?mode=${mode}`);
    const styles = await Promise.all(selectors.map(async selector => {
        const element = page.locator(selector);
        await expect(element, selector).toHaveCount(1);
        return element.evaluate(node => {
            const style = getComputedStyle(node);
            return {
                backgroundColor: style.backgroundColor,
                borderRadius: style.borderRadius,
                borderTopColor: style.borderTopColor,
                color: style.color,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                padding: style.padding,
            };
        });
    }));
    page.off('request', listener);
    return { requests, styles };
}

test('is independent of stylesheet load order', async ({ page }) => {
    const legacyFirstLegacy = await capture(page, 'both', legacySelectors);
    const legacyFirstRecipe = await capture(page, 'both', recipeSelectors);
    const recipeFirstLegacy = await capture(
        page,
        'both',
        legacySelectors,
        '/test/fixtures/recipe-console-css-isolation-recipe-first.html',
    );
    const recipeFirstRecipe = await capture(
        page,
        'both',
        recipeSelectors,
        '/test/fixtures/recipe-console-css-isolation-recipe-first.html',
    );

    expect(recipeFirstLegacy.styles).toEqual(legacyFirstLegacy.styles);
    expect(recipeFirstRecipe.styles).toEqual(legacyFirstRecipe.styles);
});

test('survives Recipe Console to legacy to Recipe Console navigation', async ({ page }) => {
    const recipeUrl = '/?provider=simulated&v=1&experience=recipe-console&view=execute';
    await page.goto(recipeUrl);
    const commandBar = page.locator('[data-command-bar]');
    const controlOverview = page.getByRole('region', { name: 'Control overview' });
    await expect(commandBar).toBeVisible();
    await expect(controlOverview).toBeVisible();
    const captureRealRecipeStyles = async () => ({
        commandBar: await commandBar.evaluate(node => {
            const style = getComputedStyle(node);
            return {
                backgroundColor: style.backgroundColor,
                borderBottomColor: style.borderBottomColor,
                color: style.color,
                display: style.display,
                height: style.height,
            };
        }),
        controlOverview: await controlOverview.evaluate(node => {
            const style = getComputedStyle(node);
            return {
                backgroundColor: style.backgroundColor,
                borderTopColor: style.borderTopColor,
                display: style.display,
                gap: style.gap,
                padding: style.padding,
            };
        }),
        controlRunSelect: await controlOverview.getByRole('combobox', {
            name: 'Control run',
        }).evaluate(node => {
            const style = getComputedStyle(node);
            return {
                backgroundColor: style.backgroundColor,
                borderRadius: style.borderRadius,
                minHeight: style.minHeight,
            };
        }),
    });
    const before = await captureRealRecipeStyles();

    await page.evaluate(() => {
        history.pushState({}, '', '/?provider=simulated&experience=legacy&tab=auth');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);

    await page.evaluate((url) => {
        history.pushState({}, '', url);
        dispatchEvent(new PopStateEvent('popstate'));
    }, recipeUrl);
    await expect(commandBar).toBeVisible();
    await expect(controlOverview).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);
    const after = await captureRealRecipeStyles();
    expect(after).toEqual(before);
});

test('keeps representative legacy and recipe console styles isolated', async ({ page }) => {
    const legacyOnly = await capture(page, 'legacy', legacySelectors);
    const recipeOnly = await capture(page, 'recipe-console', recipeSelectors);
    const mixedLegacy = await capture(page, 'both', legacySelectors);
    const mixedRecipe = await capture(page, 'both', recipeSelectors);

    expect(mixedLegacy.styles).toEqual(legacyOnly.styles);
    expect(mixedRecipe.styles).toEqual(recipeOnly.styles);
    expect(legacyOnly.requests.some(url => url.includes('tokens.css'))).toBe(false);
    expect(legacyOnly.requests.some(url => url.includes('primitives.module.css'))).toBe(false);
    expect(recipeOnly.requests.some(url => url.endsWith('/src/styles.css'))).toBe(false);
    expect(mixedLegacy.requests.some(url => url.endsWith('/src/styles.css'))).toBe(true);
    expect(mixedRecipe.requests.some(url => url.includes('tokens.css'))).toBe(true);

    await page.goto('/test/fixtures/recipe-console-css-isolation.html?mode=both');
    const recipeSurface = page.locator('[data-isolation-recipe-surface]');
    const recipeButton = page.locator('[data-isolation-recipe-button]');
    await expect(recipeSurface).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(recipeSurface).toHaveCSS('border-top-color', 'rgb(213, 219, 227)');
    await expect(recipeButton).toHaveCSS('background-color', 'rgb(36, 70, 194)');
    await expect(recipeButton).toHaveCSS('border-radius', '6px');
});
