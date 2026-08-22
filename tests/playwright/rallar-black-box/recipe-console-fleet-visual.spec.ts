import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { FLEET_ROUTE, installRecipeConsoleFleetFixture } from './recipe-console-fleet-fixture.ts';

const FLEET_PIXEL_TIME = new Date('2036-07-18T13:20:09.000Z');
const DARWIN_BASELINE_REASON =
    'Pixel baselines use the controlled Darwin render platform; semantic and geometry assertions completed before this skip.';

const DESKTOP_CASES = [
    {
        name: 'fleet-direction-a-desktop-1440x900',
        snapshot: 'direction-a-fleet-desktop.png',
        width: 1440,
        height: 900
    },
    {
        name: 'fleet-direction-a-tablet-900x900',
        snapshot: 'direction-a-fleet-tablet.png',
        width: 900,
        height: 900
    }
] as const;

const TOUCH_CASES = [
    {
        name: 'fleet-direction-a-touch-portrait-430x932',
        snapshot: 'direction-a-fleet-touch-portrait.png',
        width: 430,
        height: 932
    },
    {
        name: 'fleet-direction-a-touch-landscape-932x430',
        snapshot: 'direction-a-fleet-touch-landscape.png',
        width: 932,
        height: 430
    }
] as const;

test('captures the approved Direction A Fleet desktop and tablet matrix', async ({
    context,
    page
}, testInfo) => {
    test.setTimeout(45_000);
    await page.clock.setFixedTime(FLEET_PIXEL_TIME);
    await installRecipeConsoleFleetFixture(context, page);
    for (const contract of DESKTOP_CASES) {
        await page.setViewportSize(contract);
        await page.goto(FLEET_ROUTE);
        await expectFleetReady(page);
        await attachLayoutEvidence(page, testInfo, contract.name);
        await attachViewportScreenshot(page, testInfo, contract.name);
        await attachMapScreenshot(page, testInfo, `${contract.name}-map`);
    }

    test.skip(process.platform !== 'darwin', DARWIN_BASELINE_REASON);

    for (const contract of DESKTOP_CASES) {
        await page.setViewportSize(contract);
        await page.goto(FLEET_ROUTE);
        await expectFleetReady(page);
        await attachLayoutEvidence(page, testInfo, `${contract.name}-baseline`);
        await expectFleetPixelBaseline(page, contract.snapshot);
    }
});

test('captures the approved Direction A Fleet stale operational state', async ({
    context,
    page
}, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.setFixedTime(FLEET_PIXEL_TIME);
    const fixture = await installRecipeConsoleFleetFixture(context, page);
    await page.goto(FLEET_ROUTE);
    await expectFleetReady(page);
    fixture.failRootReads();
    const reads = fixture.rootRequestCount();
    await page.getByLabel('Fleet recovery actions')
        .getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(fixture.rootRequestCount).toBeGreaterThan(reads);
    await expect(page.locator('[data-fleet-operational-state="stale"]'))
        .toBeVisible();
    await attachLayoutEvidence(
        page,
        testInfo,
        'fleet-direction-a-stale-desktop-1440x900'
    );
    await attachViewportScreenshot(
        page,
        testInfo,
        'fleet-direction-a-stale-desktop-1440x900'
    );

    test.skip(process.platform !== 'darwin', DARWIN_BASELINE_REASON);

    await expectFleetPixelBaseline(page, 'direction-a-fleet-stale-desktop.png');
});

test.describe('Direction A Fleet touch screenshot matrix', () => {
    test.use({ hasTouch: true });

    test('captures touch portrait and short landscape', async ({
        context,
        page
    }, testInfo) => {
        test.setTimeout(45_000);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.clock.setFixedTime(FLEET_PIXEL_TIME);
        await installRecipeConsoleFleetFixture(context, page);
        for (const contract of TOUCH_CASES) {
            await page.setViewportSize(contract);
            await page.goto(FLEET_ROUTE);
            await expectFleetReady(page);
            await attachLayoutEvidence(page, testInfo, contract.name);
            await attachViewportScreenshot(page, testInfo, contract.name);
            await attachMapScreenshot(page, testInfo, `${contract.name}-map`);
        }

        test.skip(process.platform !== 'darwin', DARWIN_BASELINE_REASON);

        for (const contract of TOUCH_CASES) {
            await page.setViewportSize(contract);
            await page.goto(FLEET_ROUTE);
            await expectFleetReady(page);
            await attachLayoutEvidence(page, testInfo, `${contract.name}-baseline`);
            await expectFleetPixelBaseline(page, contract.snapshot);
        }
    });
});

async function expectFleetReady(page: Page): Promise<void> {
    const fleet = page.locator('[data-fleet-workspace]');
    await expect(fleet.locator('[data-fleet-operational-state="live"]'))
        .toBeVisible();
    await expect(fleet.getByRole('heading', { name: 'Agent × run' }))
        .toBeVisible();
    await page.locator('[data-work-surface]').evaluate((element) => {
        element.scrollTop = 0;
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
        0
    );
}

async function attachViewportScreenshot(
    page: Page,
    testInfo: TestInfo,
    name: string
): Promise<void> {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
        path,
        animations: 'disabled',
        caret: 'hide'
    });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function attachMapScreenshot(
    page: Page,
    testInfo: TestInfo,
    name: string
): Promise<void> {
    const map = page.getByRole('region', { name: 'Fleet evidence map' });
    await map.getByRole('heading', { name: 'Fleet evidence map' })
        .scrollIntoViewIfNeeded();
    const clip = await map.evaluate((element) => {
        const mapFrame = element.querySelector('svg')?.parentElement;
        if (!mapFrame) {
            throw new Error('Missing Fleet evidence map SVG frame');
        }
        const rootBounds = element.getBoundingClientRect();
        const frameBounds = mapFrame.getBoundingClientRect();
        return {
            x: rootBounds.left,
            y: rootBounds.top,
            width: rootBounds.width,
            height: frameBounds.bottom - rootBounds.top
        };
    });
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
        path,
        animations: 'disabled',
        caret: 'hide',
        captureBeyondViewport: true,
        clip
    });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function expectFleetPixelBaseline(
    page: Page,
    snapshot: string
): Promise<void> {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(page).toHaveScreenshot(snapshot, {
        animations: 'disabled',
        caret: 'hide',
        fullPage: false,
        maxDiffPixelRatio: 0.01,
        scale: 'css'
    });
}

async function attachLayoutEvidence(
    page: Page,
    testInfo: TestInfo,
    name: string
): Promise<void> {
    const layout = await page.evaluate(() => {
        const measure = (selector: string) => {
            const element = document.querySelector<HTMLElement>(selector);
            if (!element) {
                throw new Error(`Missing ${selector}`);
            }
            const bounds = element.getBoundingClientRect();
            return {
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                left: bounds.left,
                right: bounds.right,
                width: bounds.width,
                overflowX: getComputedStyle(element).overflowX,
                overflowY: getComputedStyle(element).overflowY
            };
        };
        const fleet = document.querySelector<HTMLElement>('[data-fleet-workspace]');
        if (!fleet) {
            throw new Error('Missing [data-fleet-workspace]');
        }
        const fleetRight = fleet.getBoundingClientRect().right;
        const offenders = [...fleet.querySelectorAll<HTMLElement>('*')]
            .map((element) => {
                const bounds = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                    element: [
                        element.tagName.toLowerCase(),
                        element.className && typeof element.className === 'string'
                            ? `.${element.className.trim().replaceAll(' ', '.')}`
                            : '',
                        element.getAttribute('data-fleet-window-focus-anchor')
                            ? `[data-fleet-window-focus-anchor="${
                                element.getAttribute('data-fleet-window-focus-anchor')
                            }"]`
                            : '',
                        element.getAttribute('aria-label')
                            ? `[aria-label="${element.getAttribute('aria-label')}"]`
                            : ''
                    ].join(''),
                    clientWidth: element.clientWidth,
                    scrollWidth: element.scrollWidth,
                    left: bounds.left,
                    right: bounds.right,
                    width: bounds.width,
                    overflowX: style.overflowX,
                    display: style.display
                };
            })
            .filter((candidate) =>
                candidate.width > 0 && (
                    candidate.right > fleetRight + 0.5 ||
                    candidate.scrollWidth > candidate.clientWidth + 1
                )
            )
            .sort((left, right) =>
                Math.max(
                    right.right - fleetRight,
                    right.scrollWidth - right.clientWidth
                ) - Math.max(
                    left.right - fleetRight,
                    left.scrollWidth - left.clientWidth
                )
            )
            .slice(0, 30);
        return {
            viewport: { width: innerWidth, height: innerHeight },
            document: measure('html'),
            shell: measure('[data-recipe-console-shell]'),
            work: measure('[data-work-surface]'),
            route: measure('[data-work-surface] > section'),
            fleet: measure('[data-fleet-workspace]'),
            summary: measure('[aria-labelledby="fleet-status-heading"]'),
            liveWindow: measure('[data-fleet-window-focus-anchor="Fleet live agents"]'),
            offenders
        };
    });
    await testInfo.attach(`${name}-layout`, {
        body: Buffer.from(`${JSON.stringify(layout, null, 2)}\n`),
        contentType: 'application/json'
    });
    if (
        layout.work.scrollWidth !== layout.work.clientWidth ||
        layout.route.scrollWidth !== layout.route.clientWidth ||
        layout.fleet.scrollWidth !== layout.fleet.clientWidth
    ) {
        throw new Error(`${name} width containment: ${JSON.stringify(layout)}`);
    }
    expect(layout.document.scrollWidth).toBe(layout.document.clientWidth);
    expect(layout.work.scrollWidth).toBe(layout.work.clientWidth);
    expect(layout.route.scrollWidth).toBe(layout.route.clientWidth);
    expect(layout.fleet.scrollWidth).toBe(layout.fleet.clientWidth);
}
