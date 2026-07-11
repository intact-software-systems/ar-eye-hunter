import { expect, test, type Browser } from '@playwright/test';

async function coldEntry(
    browser: Browser,
    url: string,
    visible: '.recipe-console' | '.app-shell',
    baseUrl?: string,
) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requestedResources: string[] = [];
    page.on('request', (request) => {
        if (request.resourceType() === 'script' || request.resourceType() === 'stylesheet') {
            requestedResources.push(request.url());
        }
    });
    await page.goto(baseUrl ? new URL(url, baseUrl).href : url);
    await expect(page.locator(visible)).toBeVisible();
    await expect(page.locator(
        visible === '.recipe-console' ? '.app-shell' : '.recipe-console',
    )).toHaveCount(0);
    await context.close();
    return requestedResources;
}

test('keeps one lazy experience mounted without loading the other experience', async ({ browser }) => {
    const recipeScripts = await coldEntry(
        browser,
        '/?provider=simulated&v=1&experience=recipe-console',
        '.recipe-console',
    );
    expect(recipeScripts.some((url) => url.includes('LegacyExperience')))
        .toBe(false);

    for (const legacyUrl of [
        '/?provider=simulated',
        '/?provider=simulated&tab=monitor',
    ]) {
        const legacyScripts = await coldEntry(browser, legacyUrl, '.app-shell');
        expect(legacyScripts.some((url) => url.includes('RecipeConsoleApp')))
            .toBe(false);
    }
});

test('proves each production experience static closure without fixture or peer resources', async ({ browser }) => {
    const productionBaseUrl = 'http://127.0.0.1:4176';
    const recipeResources = await coldEntry(
        browser,
        '/?provider=simulated&v=1&experience=recipe-console&view=execute',
        '.recipe-console',
        productionBaseUrl,
    );
    expect(recipeResources.some(url => /\/assets\/RecipeConsoleApp-[^/]+\.js$/.test(url))).toBe(true);
    expect(recipeResources.some(url => /\/assets\/RecipeConsoleApp-[^/]+\.css$/.test(url))).toBe(true);
    expect(recipeResources.some(url => url.includes('LegacyExperience'))).toBe(false);
    expect(recipeResources.some(url => url.includes('recipe-console-css-isolation'))).toBe(false);

    const legacyResources = await coldEntry(
        browser,
        '/?provider=simulated&experience=legacy&tab=auth',
        '.app-shell',
        productionBaseUrl,
    );
    expect(legacyResources.some(url => /\/assets\/LegacyExperience-[^/]+\.js$/.test(url))).toBe(true);
    expect(legacyResources.some(url => /\/assets\/LegacyExperience-[^/]+\.css$/.test(url))).toBe(true);
    expect(legacyResources.some(url => url.includes('RecipeConsoleApp'))).toBe(false);
    expect(legacyResources.some(url => url.includes('recipe-console-css-isolation'))).toBe(false);
});
