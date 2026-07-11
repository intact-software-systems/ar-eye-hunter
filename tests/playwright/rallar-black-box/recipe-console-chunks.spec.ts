import { expect, test, type Browser } from '@playwright/test';

async function coldEntry(
    browser: Browser,
    url: string,
    visible: '.recipe-console' | '.app-shell',
) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requestedScripts: string[] = [];
    page.on('request', (request) => {
        if (request.resourceType() === 'script') {
            requestedScripts.push(request.url());
        }
    });
    await page.goto(url);
    await expect(page.locator(visible)).toBeVisible();
    await expect(page.locator(
        visible === '.recipe-console' ? '.app-shell' : '.recipe-console',
    )).toHaveCount(0);
    await context.close();
    return requestedScripts;
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
