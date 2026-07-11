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

test('keeps auth summary typography before either experience loads', async ({ page }) => {
    const requestedScripts: string[] = [];
    page.on('request', (request) => {
        if (request.resourceType() === 'script') {
            requestedScripts.push(request.url());
        }
    });

    await page.goto(
        '/?provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.invalid',
    );
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
        .toBeVisible();
    expect(requestedScripts.some(url => url.includes('LegacyExperience')))
        .toBe(false);
    expect(requestedScripts.some(url => url.includes('RecipeConsoleApp')))
        .toBe(false);

    const termStyle = await page.locator('.auth-summary dt').first().evaluate(
        (element) => {
            const style = getComputedStyle(element);
            return { color: style.color, fontSize: style.fontSize };
        },
    );
    const descriptionStyle = await page.locator('.auth-summary dd').first()
        .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
                minWidth: style.minWidth,
                margin: style.margin,
                overflow: style.overflow,
                color: style.color,
                fontWeight: style.fontWeight,
                textOverflow: style.textOverflow,
                whiteSpace: style.whiteSpace,
            };
        });

    expect(termStyle).toEqual({
        color: 'rgb(103, 118, 111)',
        fontSize: '11.52px',
    });
    expect(descriptionStyle).toEqual({
        minWidth: '0px',
        margin: '2px 0px 0px',
        overflow: 'hidden',
        color: 'rgb(29, 40, 35)',
        fontWeight: '700',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    });
});
