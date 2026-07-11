import { expect, test } from '@playwright/test';

test('renders repository-backed Execute preview without services', async ({ page }) => {
    const controlServerRequests: string[] = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (
            url.pathname === '/control' ||
            url.pathname.startsWith('/control/') ||
            url.pathname.startsWith('/api/black-box/control')
        ) {
            controlServerRequests.push(request.url());
        }
    });

    await page.goto('/?provider=simulated&experience=recipe-console&view=execute');

    const search = page.getByRole('searchbox', { name: 'Search recipes' });
    const recipeLedger = page.getByRole('region', { name: 'Recipes' });
    await expect(search).toBeVisible();
    await search.fill('pRoViDeR pArItY');
    await expect(recipeLedger.getByText('Provider Parity', { exact: true })).toBeVisible();
    await expect(recipeLedger.getByText('RTC Realtime Stability', { exact: true })).toHaveCount(0);
    await search.clear();
    const selectedRecipe = page.getByRole('button', { name: /RTC Realtime Stability/ });
    await expect(selectedRecipe).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Provider Parity', { exact: true })).toBeVisible();
    await expect(page.getByText('Composite Evidence', { exact: true })).toBeVisible();
    await expect(page.getByText('Expected Failure', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Provider Parity/ }).click();
    await expect(page.getByRole('complementary', { name: 'Inspector' })
        .getByRole('heading', { name: 'Provider Parity' })).toBeVisible();
    await selectedRecipe.click();
    await expect(selectedRecipe).toHaveAttribute('aria-selected', 'true');

    const targets = page.getByRole('region', { name: 'Sample targets and preflight' });
    await expect(targets.getByText('2/2 selected', { exact: true })).toBeVisible();
    await expect(targets.getByText('seed-agent-a', { exact: true })).toBeVisible();
    await expect(targets.getByText('seed-agent-b', { exact: true })).toBeVisible();
    const firstTarget = targets.getByRole('checkbox', { name: 'Select seed-agent-a' });
    await firstTarget.uncheck();
    await expect(targets.getByText('1/2 selected', { exact: true })).toBeVisible();
    await firstTarget.check();
    await expect(targets.getByText('2/2 selected', { exact: true })).toBeVisible();
    await expect(targets.getByText('Required · not checked in preview', { exact: true }))
        .toBeVisible();

    await expect(page.getByText('5 manifest commands - 25 stream frames', { exact: true }))
        .toBeVisible();
    await expect(page.getByText('Preview only', { exact: true })).toBeVisible();
    const cancel = page.getByRole('button', { name: 'Cancel Preview' });
    await expect(cancel).toBeDisabled();
    await expect(page.getByText('Nothing to cancel until live execution is available.', { exact: true }))
        .toBeVisible();
    const start = page.getByRole('button', { name: 'Start Preview', exact: true });
    await expect(start).toHaveCount(1);
    await expect(start).toHaveAttribute('data-primary-action', 'true');
    await expect(page.getByText('Live execution begins in Iteration 4.', { exact: true }))
        .toBeVisible();

    await expect(page.locator('[data-preview-status]')).toHaveText('Idle preview');
    await page.getByRole('button', { name: 'Stage Preview', exact: true }).click();
    await expect(page.locator('[data-preview-status]')).toHaveText('Staged preview');
    await start.click();
    await expect(page.locator('[data-preview-status]')).toHaveText('Started preview');
    expect(controlServerRequests).toEqual([]);
});

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
