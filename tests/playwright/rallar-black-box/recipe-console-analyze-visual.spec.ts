import {
    expect,
    test,
    type Locator,
    type Page,
    type TestInfo,
} from '@playwright/test';
import {
    createAnalyzeLooseFiles,
} from './recipe-console-analyze-artifacts.ts';
import { installRecipeConsoleAnalyzeFixture } from './recipe-console-analyze-fixture.ts';
import {
    ANALYZE_FAILURE_MESSAGE,
    ANALYZE_ROUTE,
} from './recipe-console-analyze-run-data.ts';

const LEGACY_ROUTE = '/?provider=simulated&experience=legacy&tab=auth';
const SECTION_ORDER = [
    'source',
    'verdict',
    'quality',
    'performance',
    'search',
    'markdown',
] as const;

async function importArtifact(page: Page): Promise<void> {
    await page.locator('[data-analyze-file-input]')
        .setInputFiles([...createAnalyzeLooseFiles()]);
    await expect(page.locator('[data-analyze-section="verdict"]'))
        .toContainText(ANALYZE_FAILURE_MESSAGE);
}

async function navigateInApp(page: Page, href: string): Promise<void> {
    await page.evaluate(nextHref => {
        history.pushState({}, '', nextHref);
        dispatchEvent(new PopStateEvent('popstate'));
    }, href);
}

async function expectResponsiveArtifact(page: Page): Promise<void> {
    const workspace = page.locator('[data-analyze-workspace]');
    const sections = workspace.locator('[data-analyze-section]');
    await expect(sections).toHaveCount(SECTION_ORDER.length);
    expect(await sections.evaluateAll(nodes => nodes.map(node =>
        node.getAttribute('data-analyze-section')
    ))).toEqual(SECTION_ORDER);

    expect(await page.evaluate(() => ({
        body: document.body.scrollWidth - window.innerWidth,
        root: document.documentElement.scrollWidth - window.innerWidth,
    }))).toEqual({ body: 0, root: 0 });

    const verdict = workspace.locator('[data-analyze-section="verdict"]');
    const failure = verdict.locator('[data-first-actionable-failure]');
    await expect(verdict).toContainText(ANALYZE_FAILURE_MESSAGE);
    await expect(failure).toContainText('Next action');
    await failure.scrollIntoViewIfNeeded();
    await expect(failure).toBeInViewport({ ratio: 1 });

    const undersized = await workspace.locator(
        'button, input:not([type="file"]), select, summary, label[for]',
    ).evaluateAll(elements => elements.flatMap(element => {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return [];
        const bounds = node.getBoundingClientRect();
        return bounds.width + .5 < 44 || bounds.height + .5 < 44
            ? [{
                label: node.getAttribute('aria-label') ?? node.textContent?.trim(),
                width: bounds.width,
                height: bounds.height,
            }]
            : [];
    }));
    expect(undersized).toEqual([]);
}

async function attachViewportScreenshot(
    page: Page,
    testInfo: TestInfo,
    name: string,
): Promise<void> {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function captureAnalyzeStyles(page: Page) {
    const selectors = {
        workspace: '[data-analyze-workspace]',
        source: '[data-analyze-section="source"]',
        dropzone: '[data-analyze-dropzone]',
        verdict: '[data-analyze-section="verdict"]',
        action: '[data-first-actionable-failure] button',
        evidence: '[data-evidence-result]',
    } as const;
    return page.evaluate(entries => Object.fromEntries(
        Object.entries(entries).map(([name, selector]) => {
            const node = document.querySelector(selector);
            if (!(node instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
            const style = getComputedStyle(node);
            return [name, {
                backgroundColor: style.backgroundColor,
                borderLeftColor: style.borderLeftColor,
                borderRadius: style.borderRadius,
                color: style.color,
                display: style.display,
                fontSize: style.fontSize,
                minHeight: style.minHeight,
                padding: style.padding,
            }];
        }),
    ), selectors);
}

async function expectAnalyzeOnly(page: Page): Promise<void> {
    await expect(page.locator('[data-analyze-workspace]')).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);
}

test('keeps imported Analyze evidence usable at tablet and portrait sizes', async ({
    context,
    page,
}, testInfo) => {
    await installRecipeConsoleAnalyzeFixture(context);
    for (const contract of [
        { name: 'analyze-tablet-900x900', width: 900, height: 900 },
        { name: 'analyze-portrait-430x932', width: 430, height: 932 },
    ] as const) {
        await page.setViewportSize(contract);
        await page.goto(ANALYZE_ROUTE);
        await importArtifact(page);
        await expectResponsiveArtifact(page);

        if (contract.width === 430) {
            const dock = page.locator('[data-selection-dock]');
            const inspect = dock.getByRole('button', { name: 'Inspect' });
            await expect(dock).toBeVisible();
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
            await attachViewportScreenshot(page, testInfo, contract.name);

            await inspect.click();
            const inspector = page.getByRole('dialog', { name: 'Inspector' });
            const close = inspector.getByRole('button', { name: 'Close inspector' });
            await expect(inspector.locator('[data-analyze-inspector]')).toBeVisible();
            await expect(close).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(inspector).toHaveCount(0);
            await expect(inspect).toBeFocused();
        } else {
            await attachViewportScreenshot(page, testInfo, contract.name);
        }
    }
});

test('suppresses Analyze motion when reduced motion is requested', async ({
    context,
    page,
}) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 430, height: 932 });
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await importArtifact(page);
    await page.locator('[data-selection-dock]')
        .getByRole('button', { name: 'Inspect' }).click();
    await expect(page.getByRole('dialog', { name: 'Inspector' })).toBeVisible();

    expect(await page.evaluate(() => matchMedia(
        '(prefers-reduced-motion: reduce)',
    ).matches)).toBe(true);
    const animated = await page.locator(
        '[data-analyze-workspace] *, [data-inspector-host]',
    ).evaluateAll(elements => elements.flatMap(element => {
        const style = getComputedStyle(element);
        const hasDuration = (value: string) => value.split(',')
            .some(part => Number.parseFloat(part) > 0);
        return hasDuration(style.transitionDuration) ||
            hasDuration(style.animationDuration)
            ? [{
                element: element.tagName,
                transition: style.transitionDuration,
                animation: style.animationDuration,
            }]
            : [];
    }));
    expect(animated).toEqual([]);
});

test('isolates Analyze styles across both legacy load orders', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await importArtifact(page);
    const coldAnalyze = await captureAnalyzeStyles(page);

    await navigateInApp(page, LEGACY_ROUTE);
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('[data-analyze-workspace]')).toHaveCount(0);
    await navigateInApp(page, ANALYZE_ROUTE);
    await importArtifact(page);
    await expectAnalyzeOnly(page);
    expect(await captureAnalyzeStyles(page)).toEqual(coldAnalyze);

    const legacyFirst = await context.newPage();
    await legacyFirst.setViewportSize({ width: 900, height: 900 });
    await legacyFirst.goto(LEGACY_ROUTE);
    await expect(legacyFirst.locator('.app-shell')).toBeVisible();
    await navigateInApp(legacyFirst, ANALYZE_ROUTE);
    await importArtifact(legacyFirst);
    await expectAnalyzeOnly(legacyFirst);
    expect(await captureAnalyzeStyles(legacyFirst)).toEqual(coldAnalyze);
    await legacyFirst.close();
});
