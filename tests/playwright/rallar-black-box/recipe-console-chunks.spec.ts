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

test('scrubs an explicit Recipe Console URL even while the login gate delays lazy loading', async ({ page }) => {
    const experienceResources: string[] = [];
    page.on('request', (request) => {
        if (request.resourceType() === 'script' || request.resourceType() === 'stylesheet') {
            experienceResources.push(request.url());
        }
    });
    await page.goto(
        '/?provider=browser-rallar&v=1&experience=recipe-console&view=execute' +
        '&controlToken=query-secret' +
        '&controlUrl=wss%3A%2F%2Fcontrol.test%2Fcontrol%3Ftoken%3Dnested-secret' +
        '#TOKEN=fragment-secret&trace=keep',
    );

    await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
        .toBeVisible();
    const url = new URL(page.url());
    expect([...url.searchParams.keys()].map(key => key.toLowerCase()))
        .not.toEqual(expect.arrayContaining(['controltoken', 'controlurl']));
    expect(url.hash).toBe('#trace=keep');
    expect(url.href).not.toContain('query-secret');
    expect(url.href).not.toContain('nested-secret');
    expect(url.href).not.toContain('fragment-secret');
    await expect(page.locator('.recipe-console')).toHaveCount(0);
    expect(experienceResources.some(url => url.includes('RecipeConsoleApp')))
        .toBe(false);
});

test('does not auto-consume a Recipe Console ticket at a URL-selected API origin', async ({
    context,
    page,
}) => {
    const untrustedRequests: string[] = [];
    await context.route('https://untrusted-api.test/**', async (route) => {
        untrustedRequests.push(`${route.request().method()} ${route.request().url()}`);
        await route.fulfill({
            status: 500,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ error: 'Untrusted endpoint should not be called.' }),
        });
    });

    await page.goto(
        '/?provider=browser-rallar&v=1&experience=recipe-console&view=execute' +
        '&apiBaseUrl=https%3A%2F%2Funtrusted-api.test' +
        '#agentSessionTicket=victim-one-time-ticket',
    );
    await page.waitForTimeout(250);

    expect(untrustedRequests).toEqual([]);
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
        .toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await page.evaluate(() => {
        history.pushState(null, '', '/?provider=browser-rallar&experience=legacy');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForTimeout(250);
    expect(untrustedRequests).toEqual([]);
});

test('retains endpoint provenance when legacy transitions to Recipe Console', async ({
    context,
    page,
}) => {
    const controlAuthorizations: Array<string | null> = [];
    const brokerAuthorizations: Array<string | null> = [];
    await context.addInitScript(() => {
        localStorage.setItem('auth.session', JSON.stringify({
            clientId: 'victim-client',
            sessionId: 'victim-session',
            username: 'victim',
            accessToken: 'victim-primary-session-token',
            expiresAtEpochMs: 4_000_000_000_000,
        }));
    });
    await context.route('https://untrusted-control.test/**', async (route) => {
        const authorization = route.request().headers().authorization ?? null;
        controlAuthorizations.push(authorization);
        await route.fulfill({
            status: authorization ? 200 : 401,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(authorization
                ? { runs: [], distributedRuns: [] }
                : { error: 'Operator token required.' }),
        });
    });
    await context.route('https://untrusted-api.test/**', async (route) => {
        brokerAuthorizations.push(route.request().headers().authorization ?? null);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({
                tokenType: 'Bearer',
                token: 'brokered-operator-secret',
                issuedAtEpochMs: Date.now(),
                expiresAtEpochMs: Date.now() + 3_600_000,
                ttlMs: 3_600_000,
            }),
        });
    });

    await page.goto(
        '/?provider=simulated&experience=legacy&workspace=rallar&tab=auth' +
        '&controlUrl=https%3A%2F%2Funtrusted-control.test%2Fcontrol' +
        '&apiBaseUrl=https%3A%2F%2Funtrusted-api.test',
    );
    await expect(page.locator('.app-shell')).toBeVisible();

    await page.evaluate(() => {
        history.pushState(
            {},
            '',
            '/?provider=simulated&v=1&experience=recipe-console&view=execute',
        );
        dispatchEvent(new PopStateEvent('popstate'));
    });

    await expect(page.locator('.recipe-console')).toBeVisible();
    await expect(page.locator('[data-command-bar]').getByRole('status'))
        .toContainText('Authorization required');
    expect(controlAuthorizations).toEqual([null]);
    expect(brokerAuthorizations).toEqual([]);
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

for (const baseUrl of [
    'http://127.0.0.1:5176',
    'http://127.0.0.1:4176',
] as const) {
    test(`scrubs Recipe Console secrets before its lazy script request at ${baseUrl}`, async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        let hrefAtLazyRequest: string | undefined;
        await page.route('**/*RecipeConsoleApp*', async (route) => {
            if (
                hrefAtLazyRequest === undefined &&
                route.request().resourceType() === 'script'
            ) {
                hrefAtLazyRequest = page.url();
            }
            await route.continue();
        });
        const url = new URL('/', baseUrl);
        url.search = new URLSearchParams({
            provider: 'simulated',
            v: '1',
            experience: 'recipe-console',
            view: 'execute',
            futureField: 'keep',
            TOKEN: 'query-secret',
            CONTROLURL: 'wss://control.test/control?token=nested-secret',
        }).toString();
        url.hash = new URLSearchParams({
            agentSessionTicket: 'fragment-secret',
            trace: 'keep',
        }).toString();

        await page.goto(url.href);
        await expect(page.locator('.recipe-console')).toBeVisible();

        expect(hrefAtLazyRequest).toBeDefined();
        const captured = new URL(hrefAtLazyRequest ?? url.href);
        expect(captured.searchParams.get('futureField')).toBe('keep');
        expect([...captured.searchParams.keys()].map(key => key.toLowerCase()))
            .not.toEqual(expect.arrayContaining(['token', 'controlurl']));
        expect(captured.hash).toBe('#trace=keep');
        expect(captured.href).not.toContain('query-secret');
        expect(captured.href).not.toContain('nested-secret');
        expect(captured.href).not.toContain('fragment-secret');
        await context.close();
    });
}
