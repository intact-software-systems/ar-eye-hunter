import { expect, test, type Page } from '@playwright/test';
import { chooseAnalyzeFiles } from './recipe-console-analyze-helpers.ts';
import {
    installRecipeConsoleMonitorFixture,
    MONITOR_ROUTE,
} from './recipe-console-monitor-fixture.ts';
import { createTuneArtifactUpload } from './recipe-console-tune-artifacts.ts';
import { installRecipeConsoleTuneFixture } from './recipe-console-tune-fixture.ts';
import {
    TUNE_ANALYZE_ROUTE,
    TUNE_SLOW_AGENT_ID,
} from './recipe-console-tune-run-data.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const EXECUTE_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=execute' +
    '&applicationId=rallar-black-box&workspaceId=default' +
    '&roomId=rallar-black-box-room&controlRunId=execute-control-a';
const ADVANCED_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=advanced' +
    '&controlRunId=execute-control-a&agentId=execute-agent-a' +
    '&recipeId=rtc-realtime-stability&commandId=stability-phase&transport=rtc';

function liveExecuteSnapshot() {
    const runId = 'execute-control-a';
    const evidenceAtEpochMs = Date.parse('2026-07-11T23:59:59.500Z');
    const group = {
        applicationId: 'rallar-black-box',
        workspaceId: 'default',
        groupId: 'rallar-black-box-room',
    } as const;
    const agents = ['execute-agent-a', 'execute-agent-b'].map((agentId) => ({
        runId,
        agentId,
        connected: true,
        registeredAtEpochMs: evidenceAtEpochMs - 1_500,
        lastSeenAtEpochMs: evidenceAtEpochMs,
        lastHeartbeatAtEpochMs: evidenceAtEpochMs,
        status: 'connected',
        identity: {
            principalId: `${agentId}-principal`,
            sessionId: `${agentId}-session`,
            ...group,
            providerMode: 'browser-rallar',
            browserName: 'chromium',
            region: 'eu-north',
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: [],
    }));
    return {
        runs: [{
            runId,
            createdAtEpochMs: evidenceAtEpochMs - 9_500,
            updatedAtEpochMs: evidenceAtEpochMs,
            agents,
            commands: [],
            results: [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: [],
        }],
        distributedRuns: [],
    };
}

async function routeLiveExecuteControl(page: Page): Promise<void> {
    await page.route(CONTROL_ROUTE, async route => {
        const snapshot = liveExecuteSnapshot();
        const pathname = new URL(route.request().url()).pathname;
        const runId = /^\/runs\/([^/]+)$/.exec(pathname)?.[1];
        const run = runId
            ? snapshot.runs.find(candidate => candidate.runId === decodeURIComponent(runId))
            : undefined;
        await route.fulfill({
            status: runId && !run ? 404 : 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(runId ? run ?? { error: 'Control run not found.' } : snapshot),
        });
    });
}

type ConceptCase = Readonly<{
    name: string;
    snapshot: string;
    viewport: Readonly<{ width: number; height: number }>;
    view: 'advanced' | 'execute' | 'monitor' | 'tune';
    ready(page: Page): Promise<void>;
}>;

type AdvancedConceptLayout = Readonly<{
    contextColumns: 1 | 2;
    inspector: 'overlay' | 'rail' | 'sheet';
    linkColumns: 1 | 2;
    localScroll: boolean;
    navigation: 'bottom' | 'compact-rail' | 'rail';
    navigationFontSize: '9px' | '10px' | '13px';
}>;

const CONCEPT_CASES: readonly ConceptCase[] = [
    {
        name: 'matches the approved Execute desktop hierarchy',
        snapshot: 'signal-ledger-execute-desktop.png',
        viewport: { width: 1440, height: 900 },
        view: 'execute',
        ready: async page => {
            await expect(page.getByRole('heading', { level: 1, name: 'Execute recipe' }))
                .toBeVisible();
            await expect(page.getByRole('heading', { name: 'Recipe ledger' })).toBeVisible();
            await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
            await expect(page.locator('[data-command-bar] [data-status="passed"]'))
                .toContainText('Live · reachable');
            const commandBar = page.locator('[data-command-bar]');
            await expect(commandBar.getByText('Control run', { exact: true }).locator('..'))
                .toContainText('execute-control-a');
            await expect(commandBar.getByText('Safe targets', { exact: true }).locator('..'))
                .toContainText('2 selected · 2 recipe-safe');
            const catalogRegion = page.getByRole('region', { name: 'Recipe ledger' });
            const ledger = catalogRegion.getByRole('listbox', { name: 'Available recipes' });
            const targetRegion = page.getByRole('region', { name: 'Targets' });
            const catalogBounds = await catalogRegion.boundingBox();
            const targetBounds = await targetRegion.boundingBox();
            const ledgerBounds = await ledger.boundingBox();
            expect(Math.abs((catalogBounds?.y ?? 0) - (targetBounds?.y ?? 0)))
                .toBeLessThanOrEqual(1);
            await expect(targetRegion.locator('[data-target-status="matched"]'))
                .toHaveCount(2);
            await expect(targetRegion.getByRole('checkbox')).toHaveCount(2);
            await expect(page.getByRole('region', { name: 'Preflight' })).toBeVisible();
            await expect(page.locator('[data-execute-manifest]')).toBeVisible();
            const actions = page.getByRole('region', { name: 'Execute next action' });
            await expect(actions.getByRole('button', { name: /Resolve \d+ targets/ }))
                .toBeEnabled();
            await expect(actions.getByRole('button', { name: 'Create draft' }))
                .toHaveCount(0);
            const featuredLabels = [
                'RTC Realtime Stability',
                'Provider Parity',
                'Composite Evidence',
                'Expected Failure',
            ] as const;
            for (const label of featuredLabels) {
                await expect(catalogRegion.locator('[data-execute-recipe]').filter({
                    hasText: label,
                }))
                    .toHaveCount(1);
            }
            const lastFeatured = catalogRegion.locator('[data-execute-recipe]').filter({
                hasText: featuredLabels.at(-1) ?? '',
            });
            await lastFeatured.scrollIntoViewIfNeeded();
            const lastBounds = await lastFeatured.boundingBox();
            expect(lastBounds?.y ?? Number.NEGATIVE_INFINITY)
                .toBeGreaterThanOrEqual(ledgerBounds?.y ?? 0);
            expect((lastBounds?.y ?? 0) + (lastBounds?.height ?? 0))
                .toBeLessThanOrEqual((ledgerBounds?.y ?? 0) + (ledgerBounds?.height ?? 0) + 1);
            await ledger.evaluate(element => {
                element.scrollTop = 0;
            });
            await page.locator('[data-work-surface]').evaluate(element => {
                element.scrollTop = 0;
            });
        },
    },
    {
        name: 'matches the approved failed Monitor desktop hierarchy',
        snapshot: 'signal-ledger-monitor-failed-desktop.png',
        viewport: { width: 1440, height: 900 },
        view: 'monitor',
        ready: async page => {
            await expect(page.getByText('Outcome failed', { exact: true })).toBeVisible();
            await expect(page.locator('[data-command-bar] [data-status="passed"]'))
                .toContainText('Live · reachable');
            await expect(page.locator('[data-monitor-section="matrix"] [data-status-shape]'))
                .toHaveCount(6);
            const inspector = page.getByRole('complementary', { name: 'Inspector' });
            await expect(inspector).toBeVisible();
            expect((await inspector.boundingBox())?.width).toBe(360);
        },
    },
    {
        name: 'matches the approved Monitor portrait hierarchy',
        snapshot: 'signal-ledger-monitor-portrait.png',
        viewport: { width: 430, height: 932 },
        view: 'monitor',
        ready: async page => {
            await expect(page.getByText('Outcome failed', { exact: true })).toBeVisible();
            await expect(page.locator('[data-selection-dock]')).toBeVisible();
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
            await expect(page.getByText('Swipe phases', { exact: true })).toBeVisible();
            await expect(page.locator('[data-monitor-section="matrix"] [data-status-shape]'))
                .toHaveCount(6);
        },
    },
    {
        name: 'matches the approved Tune short-landscape hierarchy',
        snapshot: 'signal-ledger-tune-landscape.png',
        viewport: { width: 932, height: 430 },
        view: 'tune',
        ready: async page => {
            const tune = page.locator('[data-tune-workspace]');
            await expect(tune).toHaveAttribute('data-source-kind', 'artifact');
            await expect(tune).toHaveAttribute('data-source-detail', 'detailed');
            await expect(tune.locator('[data-tune-source]'))
                .toContainText('artifact · detailed');
            const command = tune.locator('[data-tune-command-timing]');
            for (const percentile of [
                'P50 400 ms',
                'P95 1,200 ms',
                'P99 1,200 ms',
            ]) {
                await expect(command).toContainText(percentile);
            }
            await expect(command.locator('[data-tune-slow-agents="command"]'))
                .toContainText(TUNE_SLOW_AGENT_ID);
            const stream = tune.locator('[data-tune-stream-health]');
            for (const evidence of [
                '30 planned',
                '5 dropped',
                '2 in-flight drops',
                '28 ms max drift',
                'P95 68 ms',
                'P99 92 ms',
            ]) {
                await expect(stream).toContainText(evidence);
            }
            await expect(stream.locator('[data-tune-slow-agents="stream"]'))
                .toContainText(TUNE_SLOW_AGENT_ID);
            await expect(tune.locator('[data-tune-hints]'))
                .toContainText('Lower cadence');

            const sourceBounds = await tune.locator('[data-tune-source]')
                .boundingBox();
            const evidencePlane = command.locator('..');
            const commandBounds = await command.boundingBox();
            const streamBounds = await stream.boundingBox();
            const workBounds = await page.locator('[data-work-surface]')
                .boundingBox();
            expect(sourceBounds).not.toBeNull();
            expect(commandBounds).not.toBeNull();
            expect(streamBounds).not.toBeNull();
            expect(workBounds).not.toBeNull();
            expect(commandBounds?.y).toBeGreaterThan(sourceBounds?.y ?? 0);
            expect(Math.abs((commandBounds?.y ?? 0) - (streamBounds?.y ?? 0)))
                .toBeLessThanOrEqual(1);
            expect(commandBounds?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(430);
            expect(streamBounds?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(430);
            expect(commandBounds?.x ?? 0).toBeGreaterThanOrEqual(workBounds?.x ?? 0);
            expect((streamBounds?.x ?? 0) + (streamBounds?.width ?? 0))
                .toBeLessThanOrEqual(
                    (workBounds?.x ?? 0) + (workBounds?.width ?? 0) + 1,
                );
            await expect(evidencePlane).toHaveCSS('column-gap', '12px');
            expect(await evidencePlane.evaluate(element => {
                const divider = getComputedStyle(element, '::after');
                const firstPane = element.firstElementChild;
                return {
                    content: divider.content,
                    matchesPaneBorder: firstPane
                        ? divider.backgroundColor ===
                            getComputedStyle(firstPane).borderTopColor
                        : false,
                    width: divider.width,
                };
            })).toEqual({
                content: '""',
                matchesPaneBorder: true,
                width: '1px',
            });
            for (const pane of [command, stream]) {
                await expect(pane).toHaveCSS('overflow-y', 'auto');
                expect(await pane.evaluate(element =>
                    element.scrollHeight > element.clientHeight
                )).toBe(true);
            }
            expect(await page.evaluate(() => ({
                x: document.documentElement.scrollWidth -
                    document.documentElement.clientWidth,
                y: document.documentElement.scrollHeight -
                    document.documentElement.clientHeight,
            }))).toEqual({ x: 0, y: 0 });
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
            await page.locator('[data-work-surface]').evaluate(element => {
                element.scrollTop = 0;
            });
        },
    },
    {
        name: 'matches the approved Advanced desktop hierarchy',
        snapshot: 'signal-ledger-advanced-desktop.png',
        viewport: { width: 1440, height: 900 },
        view: 'advanced',
        ready: page => expectAdvancedHierarchy(page, {
            contextColumns: 2,
            inspector: 'rail',
            linkColumns: 2,
            localScroll: false,
            navigation: 'rail',
            navigationFontSize: '13px',
        }),
    },
    {
        name: 'matches the approved Advanced tablet hierarchy',
        snapshot: 'signal-ledger-advanced-tablet.png',
        viewport: { width: 900, height: 900 },
        view: 'advanced',
        ready: page => expectAdvancedHierarchy(page, {
            contextColumns: 2,
            inspector: 'overlay',
            linkColumns: 2,
            localScroll: false,
            navigation: 'compact-rail',
            navigationFontSize: '9px',
        }),
    },
];

const ADVANCED_TOUCH_CASES = [
    {
        name: 'matches the approved Advanced touch portrait hierarchy',
        snapshot: 'signal-ledger-advanced-touch-portrait.png',
        viewport: { width: 430, height: 932 },
        layout: {
            contextColumns: 1,
            inspector: 'sheet',
            linkColumns: 1,
            localScroll: false,
            navigation: 'bottom',
            navigationFontSize: '9px',
        },
    },
    {
        name: 'matches the approved Advanced touch landscape hierarchy',
        snapshot: 'signal-ledger-advanced-touch-landscape.png',
        viewport: { width: 932, height: 430 },
        layout: {
            contextColumns: 2,
            inspector: 'overlay',
            linkColumns: 2,
            localScroll: true,
            navigation: 'compact-rail',
            navigationFontSize: '9px',
        },
    },
] as const satisfies readonly Readonly<{
    name: string;
    snapshot: string;
    viewport: Readonly<{ width: number; height: number }>;
    layout: AdvancedConceptLayout;
}>[];

test.describe('approved Signal Ledger concept fidelity', () => {
    for (const concept of CONCEPT_CASES) {
        test(concept.name, async ({ context, page }) => {
            await page.setViewportSize(concept.viewport);
            await page.clock.setFixedTime(new Date('2026-07-12T00:00:00.000Z'));
            if (concept.view === 'execute' || concept.view === 'advanced') {
                await routeLiveExecuteControl(page);
            } else if (concept.view === 'monitor') {
                await installRecipeConsoleMonitorFixture(context);
            } else {
                await installRecipeConsoleTuneFixture(context);
            }
            if (concept.view === 'tune') {
                await page.goto(TUNE_ANALYZE_ROUTE);
                await chooseAnalyzeFiles(page, [createTuneArtifactUpload()]);
                await page.getByRole('button', { name: 'Tune', exact: true })
                    .click();
            } else {
                await page.goto(concept.view === 'monitor'
                    ? MONITOR_ROUTE
                    : concept.view === 'advanced'
                        ? ADVANCED_ROUTE
                        : EXECUTE_ROUTE);
            }
            await expect(page.locator('.recipe-console')).toHaveAttribute(
                'data-view',
                concept.view,
            );
            await concept.ready(page);
            await page.evaluate(() => document.fonts.ready.then(() => undefined));

            test.skip(
                process.platform !== 'darwin',
                'Pixel baselines use the controlled Darwin render platform; semantic and geometry assertions completed before this skip.',
            );

            await expect(page).toHaveScreenshot(concept.snapshot, {
                animations: 'disabled',
                caret: 'hide',
                fullPage: false,
                maxDiffPixelRatio: concept.view === 'tune' ? 0 : 0.01,
                scale: 'css',
            });
        });
    }
});

test.describe('approved Direction A Advanced touch concept fidelity', () => {
    test.use({ hasTouch: true });

    for (const concept of ADVANCED_TOUCH_CASES) {
        test(concept.name, async ({ page }) => {
            await page.setViewportSize(concept.viewport);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.clock.setFixedTime(new Date('2026-07-12T00:00:00.000Z'));
            await routeLiveExecuteControl(page);
            await page.goto(ADVANCED_ROUTE);
            await expect(page.locator('.recipe-console')).toHaveAttribute(
                'data-view',
                'advanced',
            );
            expect(await page.evaluate(() => ({
                coarse: matchMedia('(pointer: coarse)').matches,
                reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
                touchPoints: navigator.maxTouchPoints,
            }))).toEqual({ coarse: true, reduced: true, touchPoints: 1 });
            await expectAdvancedHierarchy(page, concept.layout);
            await page.evaluate(() => document.fonts.ready.then(() => undefined));

            test.skip(
                process.platform !== 'darwin',
                'Pixel baselines use the controlled Darwin render platform; semantic and geometry assertions completed before this skip.',
            );

            await expect(page).toHaveScreenshot(concept.snapshot, {
                animations: 'disabled',
                caret: 'hide',
                fullPage: false,
                maxDiffPixelRatio: 0.01,
                scale: 'css',
            });
        });
    }
});

async function expectAdvancedHierarchy(
    page: Page,
    layout: AdvancedConceptLayout,
): Promise<void> {
    const shell = page.locator('[data-recipe-console-shell]');
    const advanced = page.locator('[data-advanced-workspace]');
    const context = advanced.locator('[data-advanced-context]');
    const contextGrid = context.locator('dl');
    const catalog = advanced.getByRole('navigation', {
        name: 'Advanced legacy tools',
    });
    const links = catalog.locator('[data-advanced-surface-link]');

    const viewHeading = page.getByRole('heading', {
        level: 1,
        name: 'Advanced',
    });
    await expect(viewHeading).toHaveText('Advanced');
    if (layout.navigation === 'bottom') {
        await expect(viewHeading).toBeVisible();
    }
    await expect(context.getByRole('heading', {
        name: 'Current diagnostic context',
    })).toBeVisible();
    await expect(page.locator('[data-command-bar] [data-status="passed"]'))
        .toContainText('Live · reachable');
    await expect(context.locator(
        '[data-context-field="controlRunId"] [data-exact-identifier]',
    )).toHaveText('execute-control-a');
    await expect(context.locator(
        '[data-context-field="agentId"] [data-exact-identifier]',
    )).toHaveText('execute-agent-a');
    await expect(catalog.getByRole('heading', { name: 'Direct Diagnostics' }))
        .toBeVisible();
    await expect(catalog.getByRole('heading', {
        name: 'Preserved Workflow Fallbacks',
    })).toBeVisible();
    await expect(catalog.getByRole('heading', { name: 'Advanced Legacy' }))
        .toBeVisible();
    await expect(advanced.locator('[data-advanced-category]')).toHaveCount(3);
    await expect(links).toHaveCount(22);
    await expect(shell).toHaveAttribute('data-navigation', layout.navigation);
    await expect(shell).toHaveAttribute('data-inspector-mode', layout.inspector);
    const primaryNavigation = page.locator('[data-primary-navigation]');
    const selectedNavigation = primaryNavigation.getByRole('button', {
        name: 'Advanced',
        exact: true,
    });
    await expect(selectedNavigation).toHaveAttribute('aria-current', 'page');
    await expect(selectedNavigation).toHaveCSS(
        'font-size',
        layout.navigationFontSize,
    );
    const navigationGeometry = await selectedNavigation.evaluate(node => {
        const label = node.querySelector(':scope > span');
        const navigation = node.closest('nav');
        if (!(label instanceof HTMLElement) ||
            !(navigation instanceof HTMLElement)) {
            throw new Error('Missing selected navigation label geometry owner.');
        }
        const rect = (element: Element) => {
            const bounds = element.getBoundingClientRect();
            return {
                bottom: bounds.bottom,
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
            };
        };
        return {
            button: rect(node),
            label: rect(label),
            navigation: rect(navigation),
        };
    });
    const containmentEpsilon = 0.01;
    expect(navigationGeometry.label.left)
        .toBeGreaterThanOrEqual(
            navigationGeometry.button.left - containmentEpsilon,
        );
    expect(navigationGeometry.label.right)
        .toBeLessThanOrEqual(
            navigationGeometry.button.right + containmentEpsilon,
        );
    expect(navigationGeometry.label.top)
        .toBeGreaterThanOrEqual(
            navigationGeometry.button.top - containmentEpsilon,
        );
    expect(navigationGeometry.label.bottom)
        .toBeLessThanOrEqual(
            navigationGeometry.button.bottom + containmentEpsilon,
        );
    expect(navigationGeometry.label.left)
        .toBeGreaterThanOrEqual(
            navigationGeometry.navigation.left - containmentEpsilon,
        );
    expect(navigationGeometry.label.right)
        .toBeLessThanOrEqual(
            navigationGeometry.navigation.right + containmentEpsilon,
        );
    await expect(page.locator('.app-shell')).toHaveCount(0);

    expect(await contextGrid.evaluate(element =>
        getComputedStyle(element).gridTemplateColumns
            .split(/\s+/u)
            .filter(Boolean)
    )).toHaveLength(layout.contextColumns);
    expect(await links.first().evaluate(element =>
        getComputedStyle(element).gridTemplateColumns
            .split(/\s+/u)
            .filter(Boolean)
    )).toHaveLength(layout.linkColumns);
    expect(await page.evaluate(() => ({
        x: document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight -
            document.documentElement.clientHeight,
    }))).toEqual({ x: 0, y: 0 });
    const scrollOwner = layout.localScroll
        ? advanced
        : page.locator('[data-work-surface]');
    expect(await scrollOwner.evaluate(element =>
        element.scrollHeight > element.clientHeight
    )).toBe(true);
    if (layout.localScroll) {
        await expect(scrollOwner).toHaveCSS('overflow-y', 'auto');
    }
    await scrollOwner.evaluate(element => {
        element.scrollTop = 0;
    });
}
