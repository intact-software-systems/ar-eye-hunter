import { expect, test, type BrowserContext, type Locator } from '@playwright/test';
import { chooseAnalyzeFiles } from './recipe-console-analyze-helpers.ts';
import {
    installRecipeConsoleMonitorFixture,
    MONITOR_FAILURE_AGENT_ID,
    MONITOR_FAILURE_COMMAND_ID,
    MONITOR_ROUTE
} from './recipe-console-monitor-fixture.ts';
import { createTuneArtifactUpload } from './recipe-console-tune-artifacts.ts';
import { installRecipeConsoleTuneFixture } from './recipe-console-tune-fixture.ts';
import { chooseTuneListboxOptionWithKeyboard } from './recipe-console-tune-listbox-helpers.ts';
import {
    TUNE_ANALYZE_ROUTE,
    TUNE_COMPARE_ROUTE,
    TUNE_RIGHT_RUN_ID,
    TUNE_ROUTE,
    TUNE_SLOW_AGENT_ID
} from './recipe-console-tune-run-data.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const ADVANCED_ROUTE = '/?provider=simulated&v=1&experience=recipe-console&view=advanced' +
    '&controlRunId=advanced-control&distributedRunId=advanced-distributed' +
    '&agentId=advanced-agent&recipeId=advanced-recipe&commandId=advanced-command';

async function installEmptyControlFixture(
    context: BrowserContext
): Promise<void> {
    await context.route(CONTROL_ROUTE, (route) => {
        if (route.request().method() === 'OPTIONS') {
            return route.fulfill({
                status: 204,
                headers: {
                    'access-control-allow-headers': 'content-type',
                    'access-control-allow-methods': 'GET,POST,OPTIONS',
                    'access-control-allow-origin': '*'
                }
            });
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ runs: [], distributedRuns: [] })
        });
    });
}

async function expectMinimumTargetHeight(locator: Locator, label: string): Promise<void> {
    await expect(locator.first(), `${label} should resolve a visible control`).toBeVisible();
    const count = await locator.count();
    expect(count, `${label} should resolve at least one control`).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
        const bounds = await locator.nth(index).boundingBox();
        expect(bounds, `${label} ${index + 1} should have rendered bounds`).not.toBeNull();
        if (bounds) {
            expect.soft(bounds.width, `${label} ${index + 1} target width`)
                .toBeGreaterThanOrEqual(44);
            expect.soft(bounds.height, `${label} ${index + 1} target height`)
                .toBeGreaterThanOrEqual(44);
        }
    }
}

async function expectSelectedNavigationLabelContained(
    navigation: Locator,
    expectedFontSize: string,
    label: string
): Promise<void> {
    const button = navigation.locator('button[aria-current="page"]');
    await expect(button).toHaveCSS('font-size', expectedFontSize);
    const geometry = await button.evaluate((node) => {
        const text = node.querySelector(':scope > span');
        const nav = node.closest('nav');
        if (!(text instanceof HTMLElement) || !(nav instanceof HTMLElement)) {
            throw new Error('Missing selected navigation label geometry owner.');
        }
        const rect = (element: Element) => {
            const bounds = element.getBoundingClientRect();
            return {
                bottom: bounds.bottom,
                left: bounds.left,
                right: bounds.right,
                top: bounds.top
            };
        };
        return {
            button: rect(node),
            label: rect(text),
            navigation: rect(nav)
        };
    });
    const epsilon = 0.01;
    expect(geometry.label.left, `${label} label left inside button`)
        .toBeGreaterThanOrEqual(geometry.button.left - epsilon);
    expect(geometry.label.right, `${label} label right inside button`)
        .toBeLessThanOrEqual(geometry.button.right + epsilon);
    expect(geometry.label.top, `${label} label top inside button`)
        .toBeGreaterThanOrEqual(geometry.button.top - epsilon);
    expect(geometry.label.bottom, `${label} label bottom inside button`)
        .toBeLessThanOrEqual(geometry.button.bottom + epsilon);
    expect(geometry.label.left, `${label} label left inside navigation`)
        .toBeGreaterThanOrEqual(geometry.navigation.left - epsilon);
    expect(geometry.label.right, `${label} label right inside navigation`)
        .toBeLessThanOrEqual(geometry.navigation.right + epsilon);
}

test('renders scoped shell geometry at every contract viewport', async ({ context, page }) => {
    await installRecipeConsoleTuneFixture(context);
    const route = '/?provider=simulated&v=1&experience=recipe-console&view=';

    for (
        const contract of [
            {
                viewport: { width: 1440, height: 900 },
                nav: 'rail',
                inspector: 'rail',
                command: 52,
                navSize: 184,
                inspectorSize: 352
            },
            {
                viewport: { width: 900, height: 900 },
                nav: 'compact-rail',
                inspector: 'overlay',
                command: 52,
                navSize: 64,
                inspectorSize: 360
            },
            {
                viewport: { width: 430, height: 932 },
                nav: 'bottom',
                inspector: 'sheet',
                command: 52,
                navSize: 64,
                inspectorSize: 430
            },
            {
                viewport: { width: 932, height: 430 },
                nav: 'compact-rail',
                inspector: 'overlay',
                command: 48,
                navSize: 60,
                inspectorSize: 320
            }
        ] as const
    ) {
        await page.setViewportSize(contract.viewport);
        await page.goto(
            contract.viewport.height <= 520
                ? TUNE_COMPARE_ROUTE
                : `${route}execute`
        );
        let tuneTrigger: Locator | undefined;
        if (contract.viewport.height <= 520) {
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
            tuneTrigger = page.locator('[data-tune-slow-agents] button')
                .filter({ hasText: TUNE_SLOW_AGENT_ID })
                .first();
            await tuneTrigger.focus();
            await page.keyboard.press('Enter');
            await expect(page.locator('[data-tune-inspector]'))
                .toContainText(TUNE_SLOW_AGENT_ID);
        }
        const shell = page.locator('[data-recipe-console-shell]');
        await expect(shell).toHaveAttribute('data-navigation', contract.nav);
        await expect(shell).toHaveAttribute('data-inspector-mode', contract.inspector);
        await expect(page.locator('[data-command-bar]')).toHaveCSS('height', `${contract.command}px`);
        const navBox = await page.locator('[data-primary-navigation]').boundingBox();
        expect(contract.nav === 'bottom' ? navBox?.height : navBox?.width).toBe(contract.navSize);
        expect((await shell.boundingBox())?.height).toBe(contract.viewport.height);
        if (contract.nav === 'bottom') {
            expect((await page.locator('[data-selection-dock]').boundingBox())?.height).toBe(48);
        }
        const inspector = page.locator('[data-inspector-host]');
        const inspectorBox = await inspector.boundingBox();
        expect(inspectorBox?.width).toBe(contract.inspectorSize);
        if (contract.inspector === 'rail') {
            await expect(inspector).toHaveAttribute('role', 'complementary');
            await expect(inspector).not.toHaveAttribute('aria-modal', 'true');
        }
        else {
            await expect(inspector).toHaveAttribute('role', 'dialog');
            await expect(inspector).toHaveAttribute('aria-modal', 'true');
            expect((inspectorBox?.x ?? 0) + (inspectorBox?.width ?? 0)).toBe(contract.viewport.width);
            if (contract.inspector === 'sheet') {
                expect(inspectorBox?.x).toBe(0);
                expect((inspectorBox?.y ?? 0) + (inspectorBox?.height ?? 0))
                    .toBe(contract.viewport.height - 64);
            }
            else {
                expect(inspectorBox?.y).toBe(contract.command);
                expect((inspectorBox?.y ?? 0) + (inspectorBox?.height ?? 0))
                    .toBe(contract.viewport.height);
                expect((await page.locator('[data-work-surface]').boundingBox())?.width)
                    .toBe(contract.viewport.width - contract.navSize);
            }
        }
        const overflow = await page.evaluate(() => ({
            x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            y: document.documentElement.scrollHeight - document.documentElement.clientHeight
        }));
        expect(overflow).toEqual({ x: 0, y: 0 });

        if (contract.viewport.height <= 520) {
            const source = await page.locator('[data-tune-source]').boundingBox();
            const command = await page.locator('[data-tune-command-timing]').boundingBox();
            const stream = await page.locator('[data-tune-stream-health]').boundingBox();
            const work = await page.locator('[data-work-surface]').boundingBox();
            expect(source).not.toBeNull();
            expect(command).not.toBeNull();
            expect(stream).not.toBeNull();
            expect(work).not.toBeNull();
            expect(command?.y).toBeGreaterThan(source?.y ?? 0);
            expect(Math.abs((command?.y ?? 0) - (stream?.y ?? 0)))
                .toBeLessThanOrEqual(1);
            expect(command?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(430);
            expect(stream?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(430);
            expect(command?.x ?? 0).toBeGreaterThanOrEqual(work?.x ?? 0);
            expect((stream?.x ?? 0) + (stream?.width ?? 0))
                .toBeLessThanOrEqual((work?.x ?? 0) + (work?.width ?? 0) + 1);
            await page.keyboard.press('Escape');
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
            await expect(tuneTrigger ?? page.locator('body')).toBeFocused();
        }
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`${route}execute`);
    await expect(page.locator('[data-inspector-host]')).toHaveCSS('transition-duration', '0s');
});

test('keeps the 900px tablet inspector overlaid without squeezing work', async ({ context, page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);

    const work = page.locator('[data-work-surface]');
    const before = await work.boundingBox();
    expect(before).not.toBeNull();
    expect(before?.x).toBe(64);
    expect(before?.width).toBe(836);
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    await page.locator(`[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`).click();
    const overlay = page.getByRole('dialog', { name: 'Inspector' });
    await expect(overlay).toHaveAttribute('data-mode', 'overlay');
    const after = await work.boundingBox();
    const overlayBounds = await overlay.boundingBox();
    expect(after).toEqual(before);
    expect(overlayBounds?.width).toBe(360);
    expect(overlayBounds?.x).toBe(540);
    expect(overlayBounds?.x ?? 900).toBeLessThan((after?.x ?? 0) + (after?.width ?? 0));
});

test('bounds modal inspector interaction without changing the desktop rail', async ({ browser }) => {
    for (
        const contract of [
            {
                hasTouch: false,
                mode: 'overlay',
                viewport: { width: 900, height: 900 }
            },
            {
                hasTouch: true,
                mode: 'sheet',
                viewport: { width: 430, height: 932 }
            }
        ] as const
    ) {
        const context = await browser.newContext({
            baseURL: 'http://127.0.0.1:5176',
            hasTouch: contract.hasTouch,
            viewport: contract.viewport
        });
        await installRecipeConsoleMonitorFixture(context);
        const page = await context.newPage();
        try {
            await page.goto(MONITOR_ROUTE);
            const analyzeNavigation = page.getByRole('button', {
                name: 'Analyze',
                exact: true
            });
            const analyzeBounds = await analyzeNavigation.boundingBox();
            expect(analyzeBounds).not.toBeNull();
            const trigger = contract.mode === 'sheet'
                ? page.locator('[data-selection-dock]').getByRole('button', {
                    name: 'Inspect'
                })
                : page.locator(
                    `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`
                );
            await trigger.click();

            const dialog = page.getByRole('dialog', { name: 'Inspector' });
            const backdrop = page.locator('[data-inspector-backdrop]');
            const backgroundSiblings = page.locator(
                '[data-recipe-console-shell] > ' +
                    ':not([data-inspector-host]):not([data-inspector-backdrop])'
            );
            await expect(dialog).toHaveAttribute('data-mode', contract.mode);
            await expect(dialog).toHaveAttribute('aria-modal', 'true');
            await expect(backdrop).toBeVisible();
            await expect(backdrop).toHaveAttribute('aria-hidden', 'true');
            expect(
                await backdrop.evaluate((element) => ({
                    role: element.getAttribute('role'),
                    tabIndex: element.getAttribute('tabindex')
                }))
            ).toEqual({ role: null, tabIndex: null });
            expect(await backgroundSiblings.count()).toBeGreaterThanOrEqual(3);
            for (let index = 0; index < await backgroundSiblings.count(); index += 1) {
                await expect(backgroundSiblings.nth(index)).toHaveAttribute('inert', '');
            }
            await expect(dialog).not.toHaveAttribute('inert', '');
            await expect(backdrop).not.toHaveAttribute('inert', '');
            if (analyzeBounds) {
                const point = {
                    x: analyzeBounds.x + analyzeBounds.width / 2,
                    y: analyzeBounds.y + analyzeBounds.height / 2
                };
                expect(
                    await page.evaluate(({ x, y }) =>
                        document.elementFromPoint(x, y)?.hasAttribute(
                            'data-inspector-backdrop'
                        ) ?? false, point)
                ).toBe(true);
                if (contract.hasTouch) {
                    await page.touchscreen.tap(point.x, point.y);
                }
                else {
                    await page.mouse.click(point.x, point.y);
                }
            }

            await expect(dialog).toHaveCount(0);
            await expect(backdrop).toHaveCount(0);
            await expect(page).toHaveURL(/view=monitor/);
            await expect(trigger).toBeFocused();
            const restoredSiblings = page.locator(
                '[data-recipe-console-shell] > *'
            );
            for (let index = 0; index < await restoredSiblings.count(); index += 1) {
                await expect(restoredSiblings.nth(index)).not.toHaveAttribute(
                    'inert',
                    ''
                );
            }
        }
        finally {
            await context.close();
        }
    }

    const desktop = await browser.newContext({
        baseURL: 'http://127.0.0.1:5176',
        viewport: { width: 1440, height: 900 }
    });
    await installRecipeConsoleMonitorFixture(desktop);
    const page = await desktop.newPage();
    try {
        await page.goto(MONITOR_ROUTE);
        const rail = page.getByRole('complementary', { name: 'Inspector' });
        await expect(rail).toHaveAttribute('data-mode', 'rail');
        await expect(rail).not.toHaveAttribute('aria-modal', 'true');
        await expect(page.locator('[data-inspector-backdrop]')).toHaveCount(0);
        const siblings = page.locator(
            '[data-recipe-console-shell] > :not([data-inspector-host])'
        );
        for (let index = 0; index < await siblings.count(); index += 1) {
            await expect(siblings.nth(index)).not.toHaveAttribute('inert', '');
        }
    }
    finally {
        await desktop.close();
    }
});

test('keeps short-landscape Monitor contained through a keyboard-only evidence path', async ({ context, page }) => {
    await page.setViewportSize({ width: 932, height: 430 });
    const fixture = await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);

    const failure = page.locator(
        `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`
    );
    await failure.focus();
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole('button', { name: 'Close inspector' }))
        .toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(inspector.getByRole('link', {
        name: 'Open this run in legacy Runs'
    })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(failure).toBeFocused();

    const matrix = page.locator('[data-monitor-matrix-scroller]');
    expect(await matrix.evaluate((element) => element.scrollWidth > element.clientWidth))
        .toBe(true);
    expect(
        await page.evaluate(() => ({
            x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            y: document.documentElement.scrollHeight - document.documentElement.clientHeight
        }))
    ).toEqual({ x: 0, y: 0 });

    fixture.setRunState('running');
    const actions = page.getByRole('region', { name: 'Monitor actions' });
    const refresh = actions.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-monitor-section="verdict"]'))
        .toHaveAttribute('data-run-state', 'running');

    const arm = actions.getByRole('button', { name: 'Arm Cancel', exact: true });
    await arm.focus();
    await page.keyboard.press('Enter');
    await expect(actions.getByRole('button', { name: 'Cancel armed', exact: true }))
        .toBeFocused();
    const cancel = actions.getByRole('button', { name: 'Cancel run', exact: true });
    await cancel.focus();
    await page.keyboard.press('Space');
    const cancelDialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?'
    });
    await expect(cancelDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cancelDialog).toHaveCount(0);
    await expect(cancel).toBeFocused();
    expect(
        await page.evaluate(() => ({
            x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            y: document.documentElement.scrollHeight - document.documentElement.clientHeight
        }))
    ).toEqual({ x: 0, y: 0 });
});

test('supports Tune metric and evidence inspection from the keyboard', async ({ context, page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    const fixture = await installRecipeConsoleTuneFixture(context);
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: 'http://127.0.0.1:5176' }
    );
    await page.goto(TUNE_COMPARE_ROUTE);

    const drift = page.getByRole('button', { name: 'Drift', exact: true });
    await drift.focus();
    await page.keyboard.press('Enter');
    await expect(drift).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/timingMetric=stream-drift/);
    await expect(page.locator(
        '[data-tune-comparison] [data-compare-category="performance"]'
    )).toContainText('stream-drift');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    const slowAgent = page.locator('[data-tune-command-timing]')
        .locator('[data-tune-slow-agents] button')
        .filter({ hasText: TUNE_SLOW_AGENT_ID });
    await expect(slowAgent).toHaveCount(1);
    await slowAgent.focus();
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    await expect(inspector.locator('[data-tune-inspector]'))
        .toContainText(TUNE_SLOW_AGENT_ID);
    await expect(inspector.getByRole('button', { name: 'Close inspector' }))
        .toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(slowAgent).toBeFocused();

    const inspectKnob = page.getByRole('button', { name: 'Inspect knob' });
    await inspectKnob.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-tune-inspector]'))
        .toContainText('/recipes/0/recipe/commands/0/rateHz');
    await expect(inspector.getByRole('button', { name: 'Close inspector' }))
        .toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(inspectKnob).toBeFocused();

    const candidate = page.locator('[data-tune-candidate]');
    const input = candidate.getByLabel('Candidate value');
    await input.focus();
    await input.press('ControlOrMeta+A');
    await input.pressSequentially('24');
    await expect(input).toHaveValue('24');
    const preview = candidate.getByRole('button', { name: 'Preview candidate' });
    await preview.focus();
    await page.keyboard.press('Enter');
    await expect(candidate.locator('[data-candidate-patch]'))
        .toContainText('"value": 24');
    await expect(candidate).toContainText('Source remains 30');
    const copy = candidate.getByRole('button', { name: 'Copy JSON patch' });
    await copy.focus();
    await page.keyboard.press('Space');
    await expect(candidate.getByRole('status'))
        .toContainText('Candidate patch copied');
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())))
        .toEqual([{
            op: 'replace',
            path: '/recipes/0/recipe/commands/0/rateHz',
            value: 24
        }]);

    await chooseTuneListboxOptionWithKeyboard(
        page,
        'Baseline run',
        TUNE_RIGHT_RUN_ID
    );
    await expect(page).toHaveURL(new RegExp(`compareLeft=${TUNE_RIGHT_RUN_ID}`));
    await expect(page.locator('[data-tune-comparison]'))
        .toContainText('Baseline and candidate must be different runs.');
    const copyCanonical = page.getByRole('button', {
        name: 'Copy canonical link'
    });
    await copyCanonical.focus();
    await copyCanonical.press('Enter');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain(`compareLeft=${TUNE_RIGHT_RUN_ID}`);
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('keeps long retention scope and the safe action visible in short landscape', async ({ context, page }) => {
    await page.setViewportSize({ width: 932, height: 430 });
    await installRecipeConsoleTuneFixture(context, {
        retention: 'ready',
        retentionCandidateCount: 40
    });
    await page.goto(TUNE_ROUTE);
    await page.getByRole('button', {
        name: 'Preview cleanup',
        exact: true
    }).click();
    await page.getByRole('button', {
        name: 'Review cleanup',
        exact: true
    }).click();

    const dialog = page.getByRole('alertdialog', {
        name: 'Delete previewed runs?'
    });
    const keep = dialog.getByRole('button', { name: 'Keep history' });
    await expect(dialog.getByRole('heading', {
        name: 'Delete previewed runs?'
    })).toBeVisible();
    await expect(keep).toBeVisible();
    await expect(keep).toBeFocused();
    const candidateList = dialog.getByRole('region', {
        name: 'Previewed runs to delete'
    });
    expect(await candidateList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
    await page.keyboard.press('Shift+Tab');
    await expect(candidateList).toBeFocused();
    const initialScrollTop = await candidateList.evaluate(
        (element) => element.scrollTop
    );
    await page.keyboard.press('PageDown');
    await expect.poll(() =>
        candidateList.evaluate(
            (element) => element.scrollTop
        )
    ).toBeGreaterThan(initialScrollTop);
    await expect(dialog).toContainText('history-overflow-control-39');
});

test('contains real History at every contract viewport', async ({ context, page }) => {
    await installRecipeConsoleTuneFixture(context, { retention: 'ready' });
    for (
        const contract of [
            { viewport: { width: 1440, height: 900 }, columns: 4, tableOverflow: false },
            { viewport: { width: 900, height: 900 }, columns: 2, tableOverflow: true },
            { viewport: { width: 430, height: 932 }, columns: 1, tableOverflow: true },
            { viewport: { width: 932, height: 430 }, columns: 4, tableOverflow: true }
        ] as const
    ) {
        await page.setViewportSize(contract.viewport);
        await page.goto(TUNE_ROUTE);
        const history = page.locator('[data-history-workspace]');
        const filterGrid = history.locator('[data-history-filters] form > div')
            .first();
        const table = history.getByRole('region', { name: 'Recipe run history' });
        await expect(history).toBeVisible();
        expect(await filterGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length))
            .toBe(contract.columns);
        expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
            contract.tableOverflow
        );
        expect(
            await page.evaluate(() => ({
                x: document.documentElement.scrollWidth -
                    document.documentElement.clientWidth,
                y: document.documentElement.scrollHeight -
                    document.documentElement.clientHeight
            }))
        ).toEqual({ x: 0, y: 0 });
        if (contract.viewport.height <= 520) {
            const tune = page.locator('[data-tune-workspace]');
            expect(await tune.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
            await history.getByRole('button', {
                name: 'Preview cleanup',
                exact: true
            }).scrollIntoViewIfNeeded();
            await expect(history.getByRole('button', {
                name: 'Preview cleanup',
                exact: true
            })).toBeVisible();
        }
    }
});

test('keeps History retention motionless and focus-contained under reduced motion', async ({ context, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleTuneFixture(context, { retention: 'ready' });
    await page.goto(TUNE_ROUTE);
    const preview = page.getByRole('button', {
        name: 'Preview cleanup',
        exact: true
    });
    await preview.click();
    await expect(page.locator('[data-retention-panel]').getByRole('status'))
        .toContainText('Retention preview is current.');
    await page.getByRole('button', {
        name: 'Review cleanup',
        exact: true
    }).click();

    const backdrop = page.locator('[data-retention-confirm-dialog]');
    const dialog = page.getByRole('alertdialog', {
        name: 'Delete previewed runs?'
    });
    const keep = dialog.getByRole('button', { name: 'Keep history' });
    const confirm = dialog.getByRole('button', {
        name: 'Delete previewed runs'
    });
    const candidates = dialog.getByRole('region', {
        name: 'Previewed runs to delete'
    });
    await expect(backdrop).toHaveCSS('animation-name', 'none');
    await expect(dialog).toHaveCSS('animation-name', 'none');
    await expect(dialog).toHaveCSS('transition-duration', '0s');
    await expect(keep).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(candidates).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(candidates).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(preview).toBeFocused();
});

test('keeps real History and retention coarse targets at least 44px', async ({ browser }) => {
    const context = await browser.newContext({
        baseURL: 'http://127.0.0.1:5176',
        hasTouch: true,
        viewport: { width: 430, height: 932 }
    });
    await installRecipeConsoleTuneFixture(context, { retention: 'ready' });
    const page = await context.newPage();
    await page.goto(TUNE_ROUTE);
    const history = page.locator('[data-history-workspace]');
    await expectMinimumTargetHeight(
        history.locator('[data-history-filters] :is(input, select, button)'),
        'History filter control'
    );
    await expectMinimumTargetHeight(
        history.locator('[data-history-saved-filters] :is(input, button, summary)'),
        'History preset control'
    );
    await expectMinimumTargetHeight(
        history.getByRole('region', { name: 'Recipe run history' }).locator('button'),
        'History comparison action'
    );
    const preview = history.getByRole('button', {
        name: 'Preview cleanup',
        exact: true
    });
    await expectMinimumTargetHeight(preview, 'Retention preview');
    await preview.click();
    await expectMinimumTargetHeight(
        history.locator('[data-retention-panel] :is(button, summary)'),
        'Retention evidence control'
    );
    await history.getByRole('button', {
        name: 'Review cleanup',
        exact: true
    }).click();
    await expectMinimumTargetHeight(
        page.getByRole('alertdialog', {
            name: 'Delete previewed runs?'
        }).locator('button'),
        'Retention dialog action'
    );
    await context.close();
});

test('keeps Direction A Advanced contained across desktop, tablet, and genuine touch', async ({ browser }) => {
    test.setTimeout(60_000);
    for (
        const contract of [
            {
                name: 'desktop',
                viewport: { width: 1440, height: 900 },
                navigation: 'rail',
                inspector: 'rail',
                contextColumns: 2,
                linkColumns: 2,
                navigationFontSize: '13px',
                scrollOwner: 'work',
                touch: false
            },
            {
                name: 'tablet',
                viewport: { width: 900, height: 900 },
                navigation: 'compact-rail',
                inspector: 'overlay',
                contextColumns: 2,
                linkColumns: 2,
                navigationFontSize: '9px',
                scrollOwner: 'work',
                touch: false
            },
            {
                name: 'touch portrait',
                viewport: { width: 430, height: 932 },
                navigation: 'bottom',
                inspector: 'sheet',
                contextColumns: 1,
                linkColumns: 1,
                navigationFontSize: '9px',
                scrollOwner: 'work',
                touch: true
            },
            {
                name: 'touch landscape',
                viewport: { width: 932, height: 430 },
                navigation: 'compact-rail',
                inspector: 'overlay',
                contextColumns: 2,
                linkColumns: 2,
                navigationFontSize: '9px',
                scrollOwner: 'advanced',
                touch: true
            }
        ] as const
    ) {
        const context = await browser.newContext({
            baseURL: 'http://127.0.0.1:5176',
            hasTouch: contract.touch,
            viewport: contract.viewport
        });
        await installEmptyControlFixture(context);
        const page = await context.newPage();
        try {
            await page.goto(ADVANCED_ROUTE);
            const shell = page.locator('[data-recipe-console-shell]');
            const advanced = page.locator('[data-advanced-workspace]');
            const contextGrid = advanced.locator('[data-advanced-context] dl');
            const links = advanced.locator('[data-advanced-surface-link]');
            const firstLink = links.first();

            const viewHeading = page.getByRole('heading', {
                level: 1,
                name: 'Advanced'
            });
            await expect(viewHeading).toHaveText('Advanced');
            if (contract.navigation === 'bottom') {
                await expect(viewHeading).toBeVisible();
            }
            await expect(advanced).toBeVisible();
            await expect(shell).toHaveAttribute(
                'data-navigation',
                contract.navigation
            );
            await expect(shell).toHaveAttribute(
                'data-inspector-mode',
                contract.inspector
            );
            await expect(advanced.locator('[data-advanced-category]'))
                .toHaveCount(3);
            await expect(links).toHaveCount(22);
            expect(
                await contextGrid.evaluate((element) =>
                    getComputedStyle(element).gridTemplateColumns
                        .split(/\s+/u)
                        .filter(Boolean)
                ),
                `${contract.name} context columns`
            ).toHaveLength(
                contract.contextColumns
            );
            expect(
                await firstLink.evaluate((element) =>
                    getComputedStyle(element).gridTemplateColumns
                        .split(/\s+/u)
                        .filter(Boolean)
                ),
                `${contract.name} link columns`
            ).toHaveLength(
                contract.linkColumns
            );
            await expectMinimumTargetHeight(
                page.locator('[data-primary-navigation] button'),
                `${contract.name} primary navigation`
            );
            await expectSelectedNavigationLabelContained(
                page.locator('[data-primary-navigation]'),
                contract.navigationFontSize,
                contract.name
            );
            const clippedNavigationLabels = await page.locator(
                '[data-primary-navigation] button'
            ).evaluateAll((buttons) =>
                buttons.flatMap((button) => {
                    const label = button.querySelector('span');
                    if (!label) {
                        return [];
                    }
                    const buttonRect = button.getBoundingClientRect();
                    const labelRect = label.getBoundingClientRect();
                    const contained = labelRect.left >= buttonRect.left - 0.5 &&
                        labelRect.right <= buttonRect.right + 0.5;
                    return contained ? [] : [{
                        buttonWidth: buttonRect.width,
                        label: label.textContent ?? '',
                        labelWidth: labelRect.width,
                        leftOverflow: buttonRect.left - labelRect.left,
                        rightOverflow: labelRect.right - buttonRect.right
                    }];
                })
            );
            expect(
                clippedNavigationLabels,
                `${contract.name} navigation labels stay inside their controls`
            ).toEqual([]);
            await expectMinimumTargetHeight(
                links,
                `${contract.name} Advanced link`
            );
            expect(
                await page.evaluate(() => ({
                    x: document.documentElement.scrollWidth -
                        document.documentElement.clientWidth,
                    y: document.documentElement.scrollHeight -
                        document.documentElement.clientHeight
                })),
                `${contract.name} document overflow`
            ).toEqual({ x: 0, y: 0 });
            const scrollOwner = contract.scrollOwner === 'advanced'
                ? advanced
                : page.locator('[data-work-surface]');
            expect(
                await scrollOwner.evaluate((element) => element.scrollHeight > element.clientHeight),
                `${contract.name} internal work scrolling`
            ).toBe(true);
            if (contract.scrollOwner === 'advanced') {
                await expect(scrollOwner).toHaveCSS('overflow-y', 'auto');
            }

            const modality = await page.evaluate(() => ({
                coarse: matchMedia('(pointer: coarse)').matches,
                hoverNone: matchMedia('(hover: none)').matches,
                touchPoints: navigator.maxTouchPoints
            }));
            if (contract.touch) {
                expect(modality, `${contract.name} touch emulation`).toEqual({
                    coarse: true,
                    hoverNone: true,
                    touchPoints: 1
                });
                const selectedNavigation = page.locator(
                    '[data-primary-navigation] button[aria-current="page"]'
                );
                await selectedNavigation.focus();
                await page.keyboard.press('Tab');
                await expect(firstLink).toBeFocused();
                await page.keyboard.press('Tab');
                await expect(links.nth(1)).toBeFocused();
                await expect(links.nth(1)).toHaveCSS('outline-style', 'solid');
                expect(await links.nth(1).evaluate((element) => element.matches(':hover'))).toBe(false);
            }
            else {
                expect(modality.touchPoints).toBe(0);
            }
        }
        finally {
            await context.close();
        }
    }
});

test('keeps Advanced motionless and keyboard-operable without hover', async ({ browser }) => {
    const context = await browser.newContext({
        baseURL: 'http://127.0.0.1:5176',
        hasTouch: true,
        reducedMotion: 'reduce',
        viewport: { width: 430, height: 932 }
    });
    await installEmptyControlFixture(context);
    const page = await context.newPage();
    try {
        await page.goto(ADVANCED_ROUTE);
        const advanced = page.locator('[data-advanced-workspace]');
        const auth = advanced.locator('[data-surface-id="direct.auth"]');
        await expect(advanced).toBeVisible();
        await page.locator(
            '[data-primary-navigation] button[aria-current="page"]'
        ).focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await expect(auth).toBeFocused();
        await expect(auth).toHaveCSS('transition-duration', '0s');
        await expect(auth).toHaveCSS('animation-name', 'none');
        expect(
            await page.evaluate(() => ({
                hoverNone: matchMedia('(hover: none)').matches,
                reduced: matchMedia('(prefers-reduced-motion: reduce)').matches
            }))
        ).toEqual({ hoverNone: true, reduced: true });

        await auth.press('Enter');
        await expect(page.locator('#panel-auth')).toBeVisible();
        await expect(page.locator('.recipe-console')).toHaveCount(0);
    }
    finally {
        await context.close();
    }
});

test('keeps representative portrait touch controls at least 44px high', async ({ context, page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=execute');
    await expectMinimumTargetHeight(
        page.locator('[data-command-bar] button'),
        'Execute command-bar button'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-primary-navigation] button'),
        'primary navigation button'
    );
    await expectMinimumTargetHeight(
        page.getByRole('searchbox', { name: 'Search recipes' }),
        'recipe search'
    );
    await expectMinimumTargetHeight(
        page.getByRole('region', { name: 'Recipe ledger' }).locator('button'),
        'recipe row'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-execute-manifest] summary'),
        'manifest summary'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-execute-agent-setup] button'),
        'Execute browser-agent setup action'
    );
    await expect(page.locator('[data-execute-action-runway] button')).toHaveCount(0);

    await page.goto(MONITOR_ROUTE);
    await expectMinimumTargetHeight(
        page.getByRole('region', { name: 'Monitor actions' }).locator('button'),
        'Monitor action'
    );
    const monitorActionOrder = await page
        .getByRole('region', { name: 'Monitor actions' })
        .locator('[data-monitor-action]')
        .evaluateAll((buttons) =>
            buttons.map((button) => ({
                label: button.textContent?.trim() ?? '',
                left: button.getBoundingClientRect().left
            }))
        );
    expect(monitorActionOrder.map((action) => action.label)).toEqual(
        ['Refresh', 'Cancel run', 'Load artifact', 'Export artifact']
    );
    expect(monitorActionOrder.map((action) => action.label)).toEqual(
        [...monitorActionOrder]
            .sort((left, right) => left.left - right.left)
            .map((action) => action.label)
    );
    await expectMinimumTargetHeight(
        page.locator('[data-failure-key]'),
        'Monitor failure control'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-monitor-section="timeline"] summary'),
        'Monitor timeline summary'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-selection-dock] button'),
        'portrait selection-dock button'
    );

    for (const view of ['analyze', 'fleet', 'advanced']) {
        await page.goto(
            `/?provider=simulated&v=1&experience=recipe-console&view=${view}`
        );
        await expectMinimumTargetHeight(
            page.locator('[data-command-bar] button'),
            `${view} command-bar button`
        );
        await expectMinimumTargetHeight(
            page.locator('[data-primary-navigation] button'),
            `${view} primary navigation button`
        );
    }
    await expectMinimumTargetHeight(
        page.locator('[data-preview-view="advanced"] a'),
        'Advanced compatibility link'
    );

    const navigationButtons = page.locator('[data-primary-navigation] button');
    const navigationBounds = await navigationButtons.evaluateAll((buttons) =>
        buttons.map((button) => {
            const bounds = button.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right };
        })
    );
    for (let index = 1; index < navigationBounds.length; index += 1) {
        expect(
            navigationBounds[index].left - navigationBounds[index - 1].right,
            `portrait navigation gap ${index}`
        ).toBeGreaterThanOrEqual(8);
    }
});

test('keeps real Tune portrait controls at least 44px', async ({ context, page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, [createTuneArtifactUpload()]);
    await page.getByRole('button', { name: 'Tune', exact: true }).click();

    await expectMinimumTargetHeight(
        page.locator(
            '[data-tune-source] [data-searchable-listbox-trigger]'
        ),
        'Tune run selector'
    );
    await expectMinimumTargetHeight(
        page.getByRole('group', { name: 'Timing metric' }).locator('button'),
        'Tune timing segment'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-tune-hints] button'),
        'Tune decision inspection'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-tune-slow-agents] button'),
        'Tune slow-agent inspection'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-tune-candidate] input'),
        'Tune candidate value'
    );
    await expectMinimumTargetHeight(
        page.locator('[data-tune-candidate] button'),
        'Tune candidate action'
    );
    expect(
        await page.evaluate(() => ({
            x: document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            y: document.documentElement.scrollHeight -
                document.documentElement.clientHeight
        }))
    ).toEqual({ x: 0, y: 0 });
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('reserves the portrait selection dock only for actionable evidence', async ({ context, page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE.replace('view=monitor', 'view=analyze'));
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'analyze');
    await expect(page.getByRole('heading', { level: 1, name: 'Analyze' })).toBeVisible();
    await expect(page.locator('[data-selection-dock]')).toHaveCount(0);

    const workBounds = await page.locator('[data-work-surface]').boundingBox();
    const navigationBounds = await page.locator('[data-primary-navigation]').boundingBox();
    expect(workBounds).not.toBeNull();
    expect(navigationBounds).not.toBeNull();
    expect((workBounds?.y ?? 0) + (workBounds?.height ?? 0))
        .toBe(navigationBounds?.y);

    await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    const dock = page.locator('[data-selection-dock]');
    await expect(dock).toBeVisible();
    await expect(dock).toContainText(`Failure · ${MONITOR_FAILURE_AGENT_ID}`);
    await dock.getByRole('button', { name: 'Inspect' }).click();
    await expect(page.getByRole('dialog', { name: 'Inspector' })).toHaveCount(1);
});

test('disables Recipe Console motion when reduced motion is requested', async ({ context, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);
    await page.locator(`[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`).click();

    const overlay = page.getByRole('dialog', { name: 'Inspector' });
    await expect(overlay).toHaveCSS('transition-duration', '0s');
    await expect(overlay).toHaveCSS('animation-name', 'none');
    await expect(page.getByRole('button', { name: 'Close inspector' }))
        .toHaveCSS('transition-duration', '0s');
});

test('disables Tune motion when reduced motion is requested', async ({ context, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_COMPARE_ROUTE);
    const trigger = page.locator('[data-tune-command-timing]')
        .locator('[data-tune-slow-agents] button')
        .filter({ hasText: TUNE_SLOW_AGENT_ID });
    await trigger.click();

    const overlay = page.getByRole('dialog', { name: 'Inspector' });
    await expect(overlay).toHaveCSS('transition-duration', '0s');
    await expect(overlay).toHaveCSS('animation-name', 'none');
    await expect(overlay.getByRole('button', { name: 'Close inspector' }))
        .toHaveCSS('transition-duration', '0s');
    await expect(page.getByRole('button', { name: 'Drift', exact: true }))
        .toHaveCSS('transition-duration', '0s');
});

test('renders all six views without relevant console warnings or errors', async ({ page }) => {
    const diagnostics: string[] = [];
    await page.route(
        /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/,
        (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' },
                body: JSON.stringify({ runs: [], distributedRuns: [] })
            })
    );
    page.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') {
            diagnostics.push(`${message.type()}: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));

    for (const view of ['execute', 'monitor', 'analyze', 'tune', 'fleet', 'advanced']) {
        await page.goto(
            `/?provider=simulated&v=1&experience=recipe-console&view=${view}`
        );
        await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', view);
        await page.evaluate(() =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            })
        );
    }

    expect(diagnostics).toEqual([]);
});

test('uses roving keyboard navigation without activating focus-only keys', async ({ page }) => {
    for (
        const contract of [
            { viewport: { width: 1440, height: 900 }, presentation: 'rail', activate: 'Enter' },
            { viewport: { width: 430, height: 932 }, presentation: 'bottom', activate: 'Space' }
        ] as const
    ) {
        await page.setViewportSize(contract.viewport);
        await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=execute');

        const navigation = page.getByRole('navigation', { name: 'Recipe Console' });
        const items = navigation.getByRole('button');
        const execute = navigation.getByRole('button', { name: 'Execute' });
        const advanced = navigation.getByRole('button', { name: 'Advanced' });
        await expect(navigation).toHaveAttribute('data-presentation', contract.presentation);
        await expect(items).toHaveCount(6);
        expect(await items.evaluateAll((buttons) => buttons.map((button) => button.tabIndex)))
            .toEqual([0, -1, -1, -1, -1, -1]);
        await expect(execute).toHaveAttribute('aria-current', 'page');
        if (contract.presentation === 'bottom') {
            const inspector = page.getByRole('dialog', { name: 'Inspector' });
            await expect(inspector.getByRole('button', {
                name: 'Close inspector'
            })).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(inspector).toHaveCount(0);
        }

        await execute.focus();
        for (
            const [key, focused] of [
                ['ArrowLeft', advanced],
                ['ArrowRight', execute],
                ['ArrowUp', advanced],
                ['ArrowDown', execute],
                ['End', advanced],
                ['Home', execute],
                ['End', advanced]
            ] as const
        ) {
            await page.keyboard.press(key);
            await expect(focused).toBeFocused();
            await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'execute');
            expect(new URL(page.url()).searchParams.get('view')).toBe('execute');
            await expect(execute).toHaveAttribute('aria-current', 'page');
        }

        expect(await items.evaluateAll((buttons) => buttons.map((button) => button.tabIndex)))
            .toEqual([-1, -1, -1, -1, -1, 0]);
        await page.keyboard.press(contract.activate);
        await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'advanced');
        expect(new URL(page.url()).searchParams.get('view')).toBe('advanced');
        await expect(advanced).toHaveAttribute('aria-current', 'page');
        await expect(execute).not.toHaveAttribute('aria-current', 'page');
        expect(await items.evaluateAll((buttons) => buttons.map((button) => button.tabIndex)))
            .toEqual([-1, -1, -1, -1, -1, 0]);
    }
});
