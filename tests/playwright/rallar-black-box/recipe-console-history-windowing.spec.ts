import {
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Locator,
    type Page,
    type Route,
} from '@playwright/test';
import {
    createRecipeConsoleControlScaleFixture,
    type RecipeConsoleControlScaleFixture,
} from '../../../packages/shared-test/rallar-bb-test/recipe-console-control-scale-fixture.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const PRODUCTION_TUNE_URL =
    'http://127.0.0.1:4176/?provider=simulated&v=1&experience=recipe-console&view=tune';

test('browses all 5,000 History pairs with bounded keyboard-safe windows',
    async ({ browser }) => {
        test.setTimeout(180_000);
        const fixture = createRecipeConsoleControlScaleFixture();
        const context = await historyContext(browser, false);
        const page = await context.newPage();
        const runtimeErrors = watchRuntimeErrors(page);

        await page.goto(PRODUCTION_TUNE_URL);
        const history = page.locator('[data-history-workspace]');
        const rows = history.locator('tbody > tr[data-history-row-key]');
        const controls = history.getByRole('group', {
            name: 'History runs window',
        });
        const status = controls.getByRole('status');
        const previous = controls.getByRole('button', { name: 'Previous' });
        const next = controls.getByRole('button', { name: 'Next' });
        const scroll = history.getByRole('region', { name: 'Recipe run history' });

        await expect(history).toBeVisible({ timeout: 60_000 });
        await expect(status).toHaveText('Showing 1–80 of 5,000 runs.');
        await expect(rows).toHaveCount(80);
        await expect(history.locator('[data-history-window-outside]'))
            .toHaveText('4,920 runs outside this render window and browseable.');
        await expectBoundedWork(history, 5_000, 80);
        expect(await controls.evaluate((node, scrollNode) =>
            !(scrollNode as HTMLElement).contains(node), await scroll.elementHandle()
        )).toBe(true);
        await expectNoDocumentOverflow(page);

        await next.focus();
        await page.keyboard.press('Enter');
        await expect(status).toHaveText('Showing 81–160 of 5,000 runs.');
        await expect(next).toBeFocused();
        const selectedId = 'scale-distributed-000080';
        await rows.first().getByRole('button', {
            name: `Set ${selectedId} as comparison baseline`,
        }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get('compareLeft'))
            .toBe(selectedId);
        await expect(status).toHaveText('Showing 81–160 of 5,000 runs.');
        await rows.first().getByRole('button', {
            name: `Set ${selectedId} as comparison candidate`,
        }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get('compareRight'))
            .toBe(selectedId);
        await expect(status).toHaveText('Showing 81–160 of 5,000 runs.');

        const disappearingAction = rows.first().getByRole('button', {
            name: `Set ${selectedId} as comparison baseline`,
        });
        await disappearingAction.focus();
        await next.evaluate((button: HTMLButtonElement) => button.click());
        await expect(status).toHaveText('Showing 161–240 of 5,000 runs.');
        await expect(history.locator('[data-history-window-focus-anchor]'))
            .toBeFocused();
        await previous.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await expect(status).toHaveText('Showing 1–80 of 5,000 runs.');

        const visitedKeys: string[] = [];
        for (let start = 0; start < fixture.counts.pairs; start += 80) {
            const end = Math.min(start + 80, fixture.counts.pairs);
            await expect(status).toHaveText(
                `Showing ${number(start + 1)}–${number(end)} of 5,000 runs.`,
            );
            await expect(rows).toHaveCount(end - start);
            await expectBoundedWork(history, 5_000, end - start);
            visitedKeys.push(...await rows.evaluateAll(elements => elements.map(
                element => element.getAttribute('data-history-row-key') ?? '',
            )));
            if (start <= fixture.positions.longBidi && fixture.positions.longBidi < end) {
                await expectExactBidiIdentity(history, fixture);
            }
            if (end < fixture.counts.pairs) await next.click();
        }
        expect(visitedKeys).toEqual(Array.from(
            { length: fixture.counts.pairs },
            (_, ordinal) => `history-row:${ordinal}`,
        ));
        expect(new Set(visitedKeys).size).toBe(fixture.counts.pairs);
        await expect(status).toHaveText('Showing 4,961–5,000 of 5,000 runs.');
        await expect(rows).toHaveCount(40);
        await expect(history.locator('[data-history-window-outside]'))
            .toHaveText('4,960 runs outside this render window and browseable.');

        const lastId = fixture.needles.distributedRunIds.last;
        const filteredId = fixture.needles.distributedRunIds.first;
        const query = history.getByLabel('Query', { exact: true });
        await query.fill(filteredId);
        const lastAction = rows.last().getByRole('button', {
            name: `Set ${lastId} as comparison baseline`,
        });
        await lastAction.focus();
        await history.locator('[data-history-filters] form').evaluate(
            (form: HTMLFormElement) => form.requestSubmit(),
        );
        await expect(controls).toHaveCount(0);
        await expect(rows).toHaveCount(1);
        await expect(history.locator('[data-history-window-focus-anchor]'))
            .toHaveText('Showing 1–1 of 1 runs.');
        await expect(history.locator('[data-history-window-focus-anchor]'))
            .toBeFocused();
        expect(new URL(page.url()).searchParams.get('historyQuery')).toBe(filteredId);
        await expectNoDocumentOverflow(page);
        expect(runtimeErrors).toEqual([]);
        await page.screenshot({ path: '/tmp/rallar-history-window-desktop.png' });
        await context.close();
    });

test('keeps History touch controls and table containment intact in mobile layouts',
    async ({ browser }) => {
        test.setTimeout(120_000);
        const context = await historyContext(browser, true);
        const page = await context.newPage();
        const runtimeErrors = watchRuntimeErrors(page);
        await page.goto(PRODUCTION_TUNE_URL);

        const history = page.locator('[data-history-workspace]');
        const rows = history.locator('tbody > tr[data-history-row-key]');
        const controls = history.getByRole('group', {
            name: 'History runs window',
        });
        const status = controls.getByRole('status');
        const previous = controls.getByRole('button', { name: 'Previous' });
        const next = controls.getByRole('button', { name: 'Next' });
        const scroll = history.getByRole('region', { name: 'Recipe run history' });

        await expect(status).toHaveText('Showing 1–80 of 5,000 runs.', {
            timeout: 60_000,
        });
        await expect(rows).toHaveCount(80);
        expect(await controlGeometry(next)).toEqual({
            minHeight: true,
            minWidth: true,
            reducedMotion: true,
        });
        expect(await scroll.evaluate(node => node.scrollWidth > node.clientWidth))
            .toBe(true);
        await expectNoDocumentOverflow(page);
        await next.tap();
        await expect(status).toHaveText('Showing 81–160 of 5,000 runs.');
        await page.screenshot({ path: '/tmp/rallar-history-window-mobile-portrait.png' });

        await page.setViewportSize({ width: 932, height: 430 });
        await expect(status).toHaveText('Showing 81–160 of 5,000 runs.');
        await expect(rows).toHaveCount(80);
        expect(await scroll.evaluate(node => node.scrollWidth > node.clientWidth))
            .toBe(true);
        await expectNoDocumentOverflow(page);
        await previous.tap();
        await expect(status).toHaveText('Showing 1–80 of 5,000 runs.');
        await page.screenshot({ path: '/tmp/rallar-history-window-mobile-landscape.png' });
        expect(runtimeErrors).toEqual([]);
        await context.close();
    });

async function historyContext(browser: Browser, mobile: boolean): Promise<BrowserContext> {
    const context = await browser.newContext({
        colorScheme: 'light',
        deviceScaleFactor: 1,
        hasTouch: mobile,
        isMobile: mobile,
        locale: 'en-US',
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
        viewport: mobile ? { width: 430, height: 932 } : { width: 1440, height: 900 },
    });
    const fixture = createRecipeConsoleControlScaleFixture();
    const runs = JSON.stringify({ runs: fixture.snapshot.runs });
    const distributedRuns = JSON.stringify({
        distributedRuns: fixture.snapshot.distributedRuns,
    });
    await context.route(CONTROL_ROUTE, route => fulfillControlRoute(
        route,
        runs,
        distributedRuns,
    ));
    return context;
}

async function fulfillControlRoute(
    route: Route,
    runs: string,
    distributedRuns: string,
): Promise<void> {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers, body: '' });
        return;
    }
    if (request.method() === 'GET' && pathname === '/runs') {
        await route.fulfill({ status: 200, contentType: 'application/json', headers, body: runs });
        return;
    }
    if (request.method() === 'GET' && pathname === '/distributed-runs') {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers,
            body: distributedRuns,
        });
        return;
    }
    await route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers,
        body: JSON.stringify({ error: `Unhandled ${request.method()} ${pathname}` }),
    });
}

async function expectBoundedWork(
    history: Locator,
    sourceRows: number,
    projectedRows: number,
): Promise<void> {
    await expect(history.locator('[data-history-projected-rows]')).toHaveAttribute(
        'data-history-control-run-visits',
        String(sourceRows),
    );
    await expect(history.locator('[data-history-projected-rows]')).toHaveAttribute(
        'data-history-distributed-run-visits',
        String(sourceRows),
    );
    for (const attribute of [
        'data-history-projected-rows',
        'data-history-label-projections',
        'data-history-catalog-run-projections',
        'data-history-action-projections',
        'data-history-control-agent-visits',
    ]) {
        await expect(history.locator('[data-history-projected-rows]')).toHaveAttribute(
            attribute,
            String(projectedRows),
        );
    }
}

async function expectExactBidiIdentity(
    history: Locator,
    fixture: RecipeConsoleControlScaleFixture,
): Promise<void> {
    const exact = history.locator(
        `[data-history-row-key="history-row:${fixture.positions.longBidi}"] bdi`,
        { hasText: fixture.needles.distributedRunIds.longBidi },
    ).first();
    await expect(exact).toHaveText(fixture.needles.distributedRunIds.longBidi);
    await expect(exact).toHaveAttribute('dir', 'ltr');
    expect(await exact.evaluate(node => ({
        direction: getComputedStyle(node).direction,
        unicodeBidi: getComputedStyle(node).unicodeBidi,
    }))).toEqual({ direction: 'ltr', unicodeBidi: 'isolate-override' });
}

async function controlGeometry(control: Locator) {
    return control.evaluate(element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
            minHeight: box.height >= 44,
            minWidth: box.width >= 44,
            reducedMotion:
                style.animationDuration === '0s' &&
                style.transitionDuration === '0s',
        };
    });
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth
    )).toBe(0);
}

function watchRuntimeErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    return errors;
}

function number(value: number): string {
    return value.toLocaleString('en-US');
}
