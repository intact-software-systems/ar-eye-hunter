import {
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Locator,
    type Page,
} from '@playwright/test';
import { createRecipeConsoleScaleFixture } from
    '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';
import { createRecipeConsoleControlScaleFixture } from
    '../../../packages/shared-test/rallar-bb-test/recipe-console-control-scale-fixture.ts';
import {
    createAnalyzeLooseFiles,
    type AnalyzeUploadFile,
} from './recipe-console-analyze-artifacts.ts';
import { installRecipeConsoleAnalyzeFixture } from
    './recipe-console-analyze-fixture.ts';
import {
    analyzeLegacyRunsLink,
    analyzeSearch,
    analyzeSource,
    chooseAnalyzeFiles,
} from './recipe-console-analyze-helpers.ts';
import {
    ANALYZE_AGENT_ID,
    ANALYZE_COMMAND_ID,
    ANALYZE_RECIPE_ID,
    ANALYZE_ROUTE,
} from './recipe-console-analyze-run-data.ts';
import {
    installRecipeConsoleLargeMonitorFixture,
    LARGE_MONITOR_COUNTS,
    LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID,
    LARGE_MONITOR_LAST_FAILURE_COMMAND_ID,
    LARGE_MONITOR_ROUTE,
} from './recipe-console-monitor-large-fixture.ts';
import {
    createExecuteScaleSnapshot,
    EXECUTE_SCALE_ROUTE,
    EXECUTE_SCALE_SELECTED_RUN_ID,
    installRecipeConsoleScaleControlFixture,
} from './recipe-console-scale-control-fixture.ts';
import { installRecipeConsoleTuneFixture } from
    './recipe-console-tune-fixture.ts';
import { verifyTuneScalePressure } from
    './recipe-console-tune-scale-proof.ts';
import { TUNE_ROUTE } from './recipe-console-tune-run-data.ts';

const PRODUCTION_BASE_URL = 'http://127.0.0.1:4176';

test('keeps synthetic large event and result lists bounded responsive and searchable',
    async ({ browser, context, page }) => {
        test.setTimeout(300_000);
        await page.setViewportSize({ width: 932, height: 430 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await installRecipeConsoleAnalyzeFixture(context);
        await installAnalyzeWorkerTelemetryTracking(context);
        await page.goto(new URL(ANALYZE_ROUTE, PRODUCTION_BASE_URL).href);
        await page.evaluate(() => { document.documentElement.dir = 'rtl'; });

        const fixture = createRecipeConsoleScaleFixture();
        expect(fixture.counts).toEqual({
            events: 12_000,
            results: 3_000,
            sourceRows: 15_000,
        });
        await chooseAnalyzeFiles(page, scaleUploads(fixture.files));
        await expect(analyzeSource(page).locator('[data-artifact-status]'))
            .toHaveText('Artifact ready', { timeout: 60_000 });

        const workspace = page.locator('[data-analyze-workspace]');
        const search = analyzeSearch(page);
        const results = search.locator('ol#analyze-evidence-results > li');
        const windowControls = search.getByRole('group', {
            name: 'Evidence results window',
        });
        const status = windowControls.getByRole('status');
        const previous = windowControls.getByRole('button', { name: 'Previous' });
        const next = windowControls.getByRole('button', { name: 'Next' });

        await expect(status).toHaveText(
            'Showing 1–64 of 15,003 retained matches.',
        );
        await expect(results).toHaveCount(64);
        await expect(workspace).toHaveAttribute('data-analyze-mounted-count', '64');
        await expect(workspace).toHaveAttribute('data-analyze-source-count', '8');
        await expect(workspace).toHaveAttribute('data-analyze-total-entry-count', '15003');
        await expect(workspace).toHaveAttribute('data-analyze-index-count', '15003');
        await expect(workspace).toHaveAttribute('data-analyze-index-omitted-count', '0');
        await expect(workspace).toHaveAttribute('data-analyze-match-count', '15003');
        await expect(previous).toBeDisabled();
        await expect(next).toBeEnabled();
        await expect(search.locator('[data-analyze-producer-compaction]'))
            .toContainText('Unavailable for distributed artifacts');
        await expect(search.locator('[data-analyze-index-omission]'))
            .toContainText('0 source entries omitted before search and not searchable');
        await expect(search.locator('[data-analyze-matching-truth]'))
            .toContainText('15,003 retained matches');
        await expect(search.locator('[data-analyze-render-window-truth]'))
            .toContainText('14,939 outside this render window and browseable');
        expect(await controlGeometry(next)).toMatchObject({
            minHeight: true,
            minWidth: true,
            reducedMotion: true,
        });
        expect(await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth
        )).toBe(0);

        await next.focus();
        await page.keyboard.press('Enter');
        await expect(status).toHaveText(
            'Showing 65–128 of 15,003 retained matches.',
        );
        await expect(next).toBeFocused();
        await expect(results).toHaveCount(64);

        await results.first().getByRole('button').focus();
        await next.evaluate((button: HTMLButtonElement) => button.click());
        await expect(status).toHaveText(
            'Showing 129–192 of 15,003 retained matches.',
        );
        await expect(status).toBeFocused();
        await expect(results).toHaveCount(64);

        await previous.focus();
        await page.keyboard.press('Enter');
        await expect(status).toHaveText(
            'Showing 65–128 of 15,003 retained matches.',
        );
        await page.keyboard.press('Enter');
        await expect(status).toHaveText(
            'Showing 1–64 of 15,003 retained matches.',
        );
        await expect(previous).toBeDisabled();

        const evidenceIds: string[] = [];
        const totalEvidence = 15_003;
        for (let rangeStart = 1; rangeStart <= totalEvidence; rangeStart += 64) {
            const rangeEnd = Math.min(rangeStart + 63, totalEvidence);
            const rangeSize = rangeEnd - rangeStart + 1;
            await expect(status).toHaveText(
                `Showing ${rangeStart.toLocaleString('en-US')}–${rangeEnd.toLocaleString('en-US')} of 15,003 retained matches.`,
            );
            await expect(results).toHaveCount(rangeSize);
            await expect(workspace).toHaveAttribute(
                'data-analyze-mounted-count',
                String(rangeSize),
            );
            const windowIds = await results.locator('[data-evidence-result]')
                .evaluateAll(elements => elements.map(element =>
                    element.getAttribute('data-evidence-id') ?? ''
                ));
            expect(windowIds).toHaveLength(rangeSize);
            expect(windowIds.every(Boolean)).toBe(true);
            evidenceIds.push(...windowIds);
            if (rangeEnd < totalEvidence) {
                await expect(next).toBeEnabled();
                await next.click();
            }
        }
        await expect(status).toHaveText(
            'Showing 14,977–15,003 of 15,003 retained matches.',
        );
        await expect(next).toBeDisabled();
        expect(evidenceIds).toHaveLength(totalEvidence);
        expect(new Set(evidenceIds).size).toBe(totalEvidence);

        await previous.click();
        await expect(status).toHaveText(
            'Showing 14,913–14,976 of 15,003 retained matches.',
        );
        await expect(results).toHaveCount(64);

        for (const [needle, kind, sourceFile, expectedCommandId] of [
            [fixture.needles.events.first, 'event', 'events.jsonl', 'scale-command-000000'],
            [fixture.needles.events.middle, 'diagnostic', 'events.jsonl', 'scale-command-000000'],
            [fixture.needles.events.last, 'event', 'events.jsonl', 'scale-command-002999'],
            [fixture.needles.results.first, 'result', 'results.jsonl', 'scale-command-000000'],
            [fixture.needles.results.middle, 'result', 'results.jsonl', 'scale-command-001500'],
            [fixture.needles.results.last, 'result', 'results.jsonl', 'scale-command-002999'],
        ] as const) {
            await search.getByLabel('Search evidence').fill(needle);
            await search.getByRole('button', { name: 'Apply search' }).click();
            await expect(search.getByLabel('Search evidence')).toHaveValue(needle);
            await expect(results).toHaveCount(1);
            await expect(results.first().getByRole('button'))
                .toHaveAttribute('data-evidence-kind', kind);
            await expect(results.first().getByRole('button'))
                .toHaveAttribute('data-evidence-source', sourceFile);
            await expect(status).toHaveText(
                'Showing 1–1 of 1 retained matches.',
            );
            await expect(workspace).toHaveAttribute('data-analyze-mounted-count', '1');
            const trigger = results.first().getByRole('button');
            await trigger.click();
            const inspector = page.getByRole('dialog', { name: 'Inspector' });
            await expect(inspector.locator('[data-analyze-inspector]'))
                .toHaveAttribute('data-selection-kind', kind);
            await expect(inspector).toContainText(sourceFile);
            await expect.poll(() => urlEvidenceSelectors(page)).toEqual({
                agentId: 'scale-agent-001',
                commandId: expectedCommandId,
                recipeId: 'recipe-console-scale-recipe',
            });
            await inspector.getByRole('button', { name: 'Close inspector' }).click();
            await expect(status).toBeFocused();
            await search.getByRole('button', { name: 'Clear filters' }).click();
            await expect(status).toHaveText(
                'Showing 1–64 of 15,003 retained matches.',
            );
        }

        await expect(analyzeLegacyRunsLink(page)).toBeVisible();
        await expect(analyzeSource(page).getByRole('link', {
            name: 'Open generic export in legacy Shared Test',
        })).toBeVisible();

        await expectExactAnalyzeWorkerTelemetry(page);
        await expectFiniteAnalyzePerformance(page);
        await verifyHistoryScale(browser);
        await verifyExecuteScale(browser);
        await verifyMonitorScale(browser);
        await verifyTuneScalePressure(browser);
        await verifyRetentionScale(browser);
    });

test('keeps multibyte bidi evidence identifiers exact and isolated in RTL',
    async ({ context, page }) => {
        await installRecipeConsoleAnalyzeFixture(context);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(ANALYZE_ROUTE);
        await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
        const identifiers = {
            agent: 'agent-‮gnul-界',
            recipe: 'מתכון-界',
            command: 'command-⁦exact⁩-🧪',
        };
        await chooseAnalyzeFiles(page, bidiUploads(identifiers));
        await expect(analyzeSource(page).locator('[data-artifact-status]'))
            .toHaveText('Artifact ready');

        const search = analyzeSearch(page);
        const result = search.locator('[data-evidence-result]').first();
        const originalResult = await result.elementHandle();
        const evidenceId = await result.getAttribute('data-evidence-id');
        for (const value of Object.values(identifiers)) {
            const exact = result.locator('bdi[data-exact-identifier]', {
                hasText: value,
            }).first();
            await expect(exact).toHaveText(value);
            await expect(exact).toHaveAttribute('dir', 'ltr');
            expect(await exact.evaluate(node => ({
                direction: getComputedStyle(node).direction,
                unicodeBidi: getComputedStyle(node).unicodeBidi,
            }))).toEqual({
                direction: 'ltr',
                unicodeBidi: 'isolate-override',
            });
        }
        await result.click();
        await expect.poll(() => urlEvidenceSelectors(page)).toEqual({
            agentId: identifiers.agent,
            commandId: identifiers.command,
            recipeId: identifiers.recipe,
        });
        await expect.poll(() => originalResult?.evaluate(
            element => element.isConnected,
        )).toBe(false);
        const inspector = page.getByRole('dialog', { name: 'Inspector' });
        await expect(inspector).toBeVisible();
        for (const value of [evidenceId, ...Object.values(identifiers)]) {
            expect(value).not.toBeNull();
            const exact = inspector.locator('bdi[data-exact-identifier]', {
                hasText: value!,
            }).first();
            await expect(exact).toHaveText(value!);
            await expect(exact).toHaveAttribute('dir', 'ltr');
            expect(await exact.evaluate(node => ({
                direction: getComputedStyle(node).direction,
                unicodeBidi: getComputedStyle(node).unicodeBidi,
            }))).toEqual({
                direction: 'ltr',
                unicodeBidi: 'isolate-override',
            });
        }
        await inspector.getByRole('button', { name: 'Close inspector' }).click();
        await expect(search.getByRole('group', {
            name: 'Evidence results window',
        }).getByRole('status')).toBeFocused();
    });

async function installAnalyzeWorkerTelemetryTracking(
    context: BrowserContext,
): Promise<void> {
    await context.addInitScript(() => {
        type Telemetry = Readonly<{
            durationMs?: number;
            parseDurationMs?: number;
            sourceFileCount?: number;
            sourceBytes?: number;
            pipelinePassCount?: number;
            sourceCollectionPassCount?: number;
            sourceFileVisitCount?: number;
            documentParseCount?: number;
            jsonlFilePassCount?: number;
            jsonlRowParseCount?: number;
            totalEntryCount?: number;
            retainedEntryCount?: number;
            indexOmittedEntryCount?: number;
            matchedEntryCount?: number;
            projectedEntryCount?: number;
        }>;
        const tracked = window as typeof window & {
            __analyzeScaleWorker?: {
                startCount: number;
                completeTelemetry: Telemetry[];
            };
        };
        tracked.__analyzeScaleWorker = {
            startCount: 0,
            completeTelemetry: [],
        };
        const NativeWorker = Worker;
        class TrackedWorker extends NativeWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                this.addEventListener('message', event => {
                    const response = event.data as
                        | { type?: unknown; telemetry?: Telemetry }
                        | undefined;
                    if (response?.type === 'complete' && response.telemetry) {
                        tracked.__analyzeScaleWorker?.completeTelemetry.push({
                            ...response.telemetry,
                        });
                    }
                });
            }

            override postMessage(message: unknown, transfer?: Transferable[]): void;
            override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
            override postMessage(
                message: unknown,
                transferOrOptions?: Transferable[] | StructuredSerializeOptions,
            ): void {
                if ((message as { type?: unknown } | undefined)?.type === 'start') {
                    const telemetry = tracked.__analyzeScaleWorker;
                    if (telemetry) telemetry.startCount += 1;
                }
                if (Array.isArray(transferOrOptions)) {
                    super.postMessage(message, transferOrOptions);
                } else {
                    super.postMessage(message, transferOrOptions);
                }
            }
        }
        Object.defineProperty(window, 'Worker', {
            configurable: true,
            value: TrackedWorker,
        });
    });
}

async function expectExactAnalyzeWorkerTelemetry(page: Page): Promise<void> {
    const tracked = await page.evaluate(() => (
        window as typeof window & {
            __analyzeScaleWorker?: {
                startCount: number;
                completeTelemetry: Array<Record<string, number>>;
            };
        }
    ).__analyzeScaleWorker);
    expect(tracked?.startCount).toBe(1);
    expect(tracked?.completeTelemetry).toHaveLength(1);
    const telemetry = tracked?.completeTelemetry[0];
    expect(telemetry).toMatchObject({
        sourceFileCount: 8,
        sourceBytes: 4_753_103,
        pipelinePassCount: 1,
        sourceCollectionPassCount: 1,
        sourceFileVisitCount: 8,
        documentParseCount: 6,
        jsonlFilePassCount: 2,
        jsonlRowParseCount: 15_000,
        totalEntryCount: 15_003,
        retainedEntryCount: 15_003,
        indexOmittedEntryCount: 0,
        matchedEntryCount: 15_003,
        projectedEntryCount: 64,
    });
    expect(Number.isFinite(telemetry?.durationMs)).toBe(true);
    expect(Number.isFinite(telemetry?.parseDurationMs)).toBe(true);
}

async function expectFiniteAnalyzePerformance(page: Page): Promise<void> {
    const measures = await page.evaluate(() => [
        'rallar.recipe-console.analyze.parse',
        'rallar.recipe-console.analyze.model',
        'rallar.recipe-console.analyze.search',
        'rallar.recipe-console.analyze.window',
    ].map(name => {
        const entry = performance.getEntriesByName(name, 'measure').at(-1) as
            | PerformanceMeasure
            | undefined;
        return {
            name,
            duration: entry?.duration,
            detail: entry?.detail as Record<string, number> | undefined,
        };
    }));
    for (const measure of measures) {
        expect(measure.duration, `${measure.name} duration`).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(measure.duration)).toBe(true);
        expect(measure.detail).toBeDefined();
        expect(Object.values(measure.detail ?? {}).every(Number.isFinite)).toBe(true);
    }
    expect(measures.find(measure => measure.name.endsWith('.parse'))?.detail)
        .toMatchObject({
            sourceCount: 8,
            indexCount: 15_003,
            matchCount: 15_003,
            mountedCount: 64,
            renderCount: 1,
        });
}

async function verifyHistoryScale(browser: Browser): Promise<void> {
    await test.step('History keeps 5,000 run pairs searchable inside 80-row windows',
        async () => {
            const context = await browser.newContext({
                baseURL: PRODUCTION_BASE_URL,
                colorScheme: 'light',
                deviceScaleFactor: 1,
                locale: 'en-US',
                reducedMotion: 'reduce',
                timezoneId: 'UTC',
                viewport: { width: 1_440, height: 900 },
            });
            try {
                const fixture = createRecipeConsoleControlScaleFixture();
                const control = await installRecipeConsoleScaleControlFixture(
                    context,
                    fixture.snapshot,
                );
                const page = await context.newPage();
                const runtimeErrors = watchRuntimeErrors(page);
                await page.goto(productionUrl(TUNE_ROUTE));

                const history = page.locator('[data-history-workspace]');
                const rows = history.locator('tbody > tr[data-history-row-key]');
                const controls = history.getByRole('group', {
                    name: 'History runs window',
                });
                const status = controls.getByRole('status');
                const next = controls.getByRole('button', { name: 'Next' });
                await expect(history).toBeVisible({ timeout: 60_000 });
                await expect(status).toHaveText('Showing 1–80 of 5,000 runs.');
                await expect(rows).toHaveCount(80);
                await expect(rows.first()).toHaveAttribute(
                    'data-history-row-key',
                    `history-row:${fixture.positions.first}`,
                );
                await expectHistoryWork(history, 5_000, 80);

                await next.focus();
                await page.keyboard.press('Enter');
                await expect(status).toHaveText('Showing 81–160 of 5,000 runs.');
                await expect(next).toBeFocused();
                await expect(rows).toHaveCount(80);

                const query = history.getByLabel('Query', { exact: true });
                for (const position of ['middle', 'last'] as const) {
                    const distributedRunId = fixture.needles.distributedRunIds[position];
                    await query.fill(distributedRunId);
                    await history.getByRole('button', { name: 'Apply filters' }).click();
                    await expect(rows).toHaveCount(1);
                    await expect(rows.first()).toHaveAttribute(
                        'data-history-row-key',
                        `history-row:${fixture.positions[position]}`,
                    );
                    await expect(rows.first()).toContainText(distributedRunId);
                    await expectHistoryWork(history, 5_000, 1);
                }

                await history.getByRole('button', { name: 'Reset' }).click();
                await expect(status).toHaveText('Showing 1–80 of 5,000 runs.');
                await expect(rows).toHaveCount(80);
                await expectNoDocumentOverflow(page);
                expect(control.snapshotReads()).toBeGreaterThan(0);
                expect(control.mutationRequests()).toEqual([]);
                expect(runtimeErrors).toEqual([]);
            } finally {
                await context.close();
            }
        });
}

async function verifyExecuteScale(browser: Browser): Promise<void> {
    await test.step('Execute bounds 250 run choices and 240 live targets without writes',
        async () => {
            const context = await browser.newContext({
                baseURL: PRODUCTION_BASE_URL,
                colorScheme: 'light',
                deviceScaleFactor: 1,
                hasTouch: true,
                isMobile: true,
                locale: 'en-US',
                reducedMotion: 'reduce',
                timezoneId: 'UTC',
                viewport: { width: 430, height: 932 },
            });
            try {
                const control = await installRecipeConsoleScaleControlFixture(
                    context,
                    createExecuteScaleSnapshot(),
                );
                const page = await context.newPage();
                const runtimeErrors = watchRuntimeErrors(page);
                await page.goto(productionUrl(EXECUTE_SCALE_ROUTE));

                const targets = page.locator('[data-execute-targets]');
                const targetRows = targets.locator('[data-execute-target]');
                const targetAnchor = targets.locator(
                    '[data-execute-window-focus-anchor="targets"]',
                );
                await expect(targets).toBeVisible({ timeout: 60_000 });
                await expect(targets.getByText('240 selected', { exact: true }))
                    .toBeVisible();
                await expect(targetRows).toHaveCount(100);
                await expect(targetAnchor).toHaveText('Showing 1–100 of 240 targets.');
                await expect(targetRows.first()).toContainText('pressure-agent-0000');
                await expect(page.locator(
                    '[data-execute-action-band] [data-connection="live"]',
                )).toHaveCount(1);

                const runTrigger = targets.locator('[data-searchable-listbox-trigger]');
                await runTrigger.focus();
                await page.keyboard.press('Enter');
                const runOptions = targets.getByRole('option');
                await expect(runOptions).toHaveCount(50);
                await expect(targets.locator('[data-searchable-listbox-range]'))
                    .toHaveText('Showing 201–250 of 250 options.');
                expect(await runOptions.count()).toBeLessThanOrEqual(100);
                await expect(targets.locator(
                    `[data-option-key="${EXECUTE_SCALE_SELECTED_RUN_ID}"]`,
                )).toHaveCount(1);
                await page.keyboard.press('Escape');
                await expect(runTrigger).toBeFocused();

                const targetWindow = targets.getByRole('group', {
                    name: 'Targets window',
                });
                const next = targetWindow.getByRole('button', { name: 'Next' });
                expect(await controlGeometry(next)).toEqual({
                    minHeight: true,
                    minWidth: true,
                    reducedMotion: true,
                });
                await next.tap();
                await expect(targetAnchor).toHaveText('Showing 101–200 of 240 targets.');
                await expect(targetRows).toHaveCount(100);
                await expect(targetRows.nth(20)).toContainText('pressure-agent-0120');
                await next.tap();
                await expect(targetAnchor).toHaveText('Showing 201–240 of 240 targets.');
                await expect(targetRows).toHaveCount(40);
                await expect(targets.getByText('pressure-agent-0239', { exact: true }))
                    .toBeVisible();

                const actions = page.locator('[data-execute-action-band]');
                await expect(actions.getByRole('button', { name: 'Resolve targets' }))
                    .toBeEnabled();
                await expect(actions.getByRole('button', { name: 'Create draft' }))
                    .toBeDisabled();
                expect(await page.evaluate(() => navigator.maxTouchPoints > 0)).toBe(true);
                await expectNoDocumentOverflow(page);
                expect(control.snapshotReads()).toBeGreaterThan(0);
                expect(control.mutationRequests()).toEqual([]);
                expect(runtimeErrors).toEqual([]);
            } finally {
                await context.close();
            }
        });
}

async function verifyMonitorScale(browser: Browser): Promise<void> {
    await test.step('Monitor keeps every pressure collection independently bounded',
        async () => {
            const context = await browser.newContext({
                baseURL: PRODUCTION_BASE_URL,
                colorScheme: 'light',
                deviceScaleFactor: 1,
                locale: 'en-US',
                reducedMotion: 'reduce',
                timezoneId: 'UTC',
                viewport: { width: 900, height: 900 },
            });
            try {
                const fixture = await installRecipeConsoleLargeMonitorFixture(context);
                const page = await context.newPage();
                const runtimeErrors = watchRuntimeErrors(page);
                await page.goto(productionUrl(LARGE_MONITOR_ROUTE));
                const verdict = page.locator('[data-monitor-section="verdict"]');
                await expect(verdict).toHaveAttribute('data-run-state', 'failed', {
                    timeout: 60_000,
                });
                await expect(verdict).toHaveAttribute(
                    'data-evidence-freshness',
                    'current',
                );
                await expect(page.getByRole('heading', {
                    name: `Failures (${LARGE_MONITOR_COUNTS.failures})`,
                })).toBeVisible();

                for (const [selector, expected] of [
                    ['[data-failure-key]', 60],
                    ['[data-monitor-agent-row]', 80],
                    ['[data-monitor-recipe-row]', 60],
                    ['[data-monitor-readiness-row]', 60],
                    ['[data-monitor-diagnostic-row]', 50],
                ] as const) {
                    const rows = page.locator(selector);
                    await expect(rows).toHaveCount(expected);
                    expect(await rows.count(), selector).toBeLessThanOrEqual(100);
                }

                const failures = page.locator('[data-monitor-section="failures"]');
                const failureRows = failures.locator('[data-monitor-source-ordinal]');
                await expect(failureRows.first().locator('[data-failure-key]')).toHaveAttribute(
                    'data-failure-key',
                    LARGE_MONITOR_FIRST_FAILURE_COMMAND_ID,
                );
                await expect(failureRows.nth(35)).toHaveAttribute(
                    'data-monitor-source-ordinal',
                    '35',
                );
                await traverseMonitorWindow({
                    budget: 60,
                    itemLabel: 'failures',
                    label: 'Failures',
                    rows: '[data-monitor-source-ordinal]',
                    scope: failures,
                    total: LARGE_MONITOR_COUNTS.failures,
                });
                await expect(failureRows).toHaveCount(10);
                await expect(failureRows.last().locator('[data-failure-key]'))
                    .toHaveAttribute(
                        'data-failure-key',
                        LARGE_MONITOR_LAST_FAILURE_COMMAND_ID,
                    );
                await expect(failureRows.last()).toHaveAttribute(
                    'data-monitor-source-ordinal',
                    '69',
                );

                await traverseMonitorWindow({
                    budget: 80,
                    itemLabel: 'agents',
                    label: 'Agents',
                    rows: '[data-monitor-agent-row]',
                    scope: page.locator('[data-monitor-section="matrix"]'),
                    total: LARGE_MONITOR_COUNTS.agents,
                });
                await traverseMonitorWindow({
                    budget: 60,
                    itemLabel: 'recipes',
                    label: 'Recipes',
                    rows: '[data-monitor-recipe-row]',
                    scope: page.locator('[data-monitor-progress]'),
                    total: LARGE_MONITOR_COUNTS.recipes,
                });
                await traverseMonitorWindow({
                    budget: 60,
                    itemLabel: 'readiness rows',
                    label: 'Readiness',
                    rows: '[data-monitor-readiness-row]',
                    scope: page.locator('[data-monitor-progress]'),
                    total: LARGE_MONITOR_COUNTS.readiness,
                });
                await traverseMonitorWindow({
                    budget: 50,
                    itemLabel: 'diagnostics',
                    label: 'Diagnostics',
                    rows: '[data-monitor-diagnostic-row]',
                    scope: page.locator('[data-monitor-diagnostics]'),
                    total: LARGE_MONITOR_COUNTS.diagnostics,
                });

                for (const contract of [
                    {
                        itemLabel: 'timeline rows',
                        label: 'Timeline' as const,
                        total: LARGE_MONITOR_COUNTS.timeline,
                    },
                    {
                        itemLabel: 'events',
                        label: 'Events' as const,
                        total: LARGE_MONITOR_COUNTS.events,
                    },
                    {
                        itemLabel: 'composites',
                        label: 'Composite results' as const,
                        total: LARGE_MONITOR_COUNTS.composites,
                    },
                ]) {
                    const disclosure = monitorDisclosure(page, contract.label);
                    const summary = disclosure.locator('summary');
                    const rows = disclosure.locator('[data-monitor-disclosure-row]');
                    const url = page.url();
                    await expect(summary).toHaveText(
                        `${contract.label} (${monitorNumber(contract.total)})`,
                    );
                    await expect(rows).toHaveCount(0);
                    await expect(disclosure.getByRole('group', {
                        name: `${contract.label} window`,
                    })).toHaveCount(0);
                    await summary.click();
                    await expect(page).toHaveURL(url);
                    await expect(rows).toHaveCount(Math.min(40, contract.total));
                    await traverseMonitorWindow({
                        budget: 40,
                        itemLabel: contract.itemLabel,
                        label: contract.label,
                        rows: '[data-monitor-disclosure-row]',
                        scope: disclosure,
                        total: contract.total,
                    });
                    await summary.click();
                    await expect(page).toHaveURL(url);
                    await expect(rows).toHaveCount(0);
                    await expect(disclosure.getByRole('group', {
                        name: `${contract.label} window`,
                    })).toHaveCount(0);
                }

                expect(fixture.mutationRequestCount()).toBe(0);
                await expectNoDocumentOverflow(page);
                expect(runtimeErrors).toEqual([]);
            } finally {
                await context.close();
            }
        });
}

async function verifyRetentionScale(browser: Browser): Promise<void> {
    await test.step('Retention keeps aggregate consequences at 100 without confirmation',
        async () => {
            const context = await retentionContext(browser);
            try {
                const fixture = await installRecipeConsoleTuneFixture(context, {
                    retention: 'ready',
                    retentionCandidateCount: 205,
                });
                const page = await context.newPage();
                const runtimeErrors = watchRuntimeErrors(page);
                await page.goto(productionUrl(TUNE_ROUTE));
                await page.getByRole('button', {
                    name: 'Preview cleanup',
                    exact: true,
                }).tap();

                const retention = page.locator('[data-retention-panel]');
                const pressure = retentionPressureRows(page);
                await expect(retention.locator('[data-retention-candidate-row]'))
                    .toHaveCount(50);
                await expect(pressure).toHaveCount(50);
                await expect(retention).toContainText('Showing 1–50 of 205 candidates.');

                const controlIds = retention.getByText('Control run IDs (205)', {
                    exact: true,
                });
                await controlIds.tap();
                await expect(retention.locator('[data-retention-total-id-row]'))
                    .toHaveCount(50);
                await expect(pressure).toHaveCount(100);
                await controlIds.tap();
                await expect(retention.locator('[data-retention-total-id-row]'))
                    .toHaveCount(0);

                const candidateNext = retention.getByRole('group', {
                    name: 'Retention candidates window',
                }).getByRole('button', { name: 'Next' });
                expect(await controlGeometry(candidateNext)).toEqual({
                    minHeight: true,
                    minWidth: true,
                    reducedMotion: true,
                });
                for (let index = 0; index < 4; index += 1) {
                    await candidateNext.tap();
                }
                await expect(retention.locator('[data-retention-candidate-row]'))
                    .toHaveCount(5);
                await expect(retention).toContainText('Showing 201–205 of 205 candidates.');
                await expect(retention.locator('[data-retention-candidate-row]').last())
                    .toContainText('history-overflow-control-204');

                await page.getByRole('button', {
                    name: 'Review cleanup',
                    exact: true,
                }).tap();
                const dialog = page.getByRole('alertdialog', {
                    name: 'Delete previewed runs?',
                });
                await expect(retention.locator('[data-retention-candidate-row]'))
                    .toHaveCount(0);
                await expect(dialog.locator('[data-retention-dialog-candidate-row]'))
                    .toHaveCount(50);
                await expect(pressure).toHaveCount(50);
                await page.keyboard.press('Escape');
                await expect(dialog).toHaveCount(0);

                expectPreviewOnly(fixture);
                expect(await page.locator('body').innerHTML()).not.toContain('history-plan-');
                expect(await page.evaluate(() => navigator.maxTouchPoints > 0)).toBe(true);
                await expectNoDocumentOverflow(page);
                expect(runtimeErrors).toEqual([]);
            } finally {
                await context.close();
            }

            const consequenceContext = await retentionContext(browser);
            try {
                const fixture = await installRecipeConsoleTuneFixture(
                    consequenceContext,
                    {
                        retention: 'ready',
                        retentionCandidateCount: 1,
                        retentionLinkedCount: 201,
                    },
                );
                const page = await consequenceContext.newPage();
                const runtimeErrors = watchRuntimeErrors(page);
                await page.goto(productionUrl(TUNE_ROUTE));
                await page.getByRole('button', {
                    name: 'Preview cleanup',
                    exact: true,
                }).tap();
                const candidate = page.locator('[data-retention-candidate-row]');
                const pressure = retentionPressureRows(page);
                await expect(candidate).toHaveCount(1);
                await candidate.getByText('Linked distributed runs (201)', {
                    exact: true,
                }).tap();
                await expect(candidate.locator('[data-retention-linked-run-row]'))
                    .toHaveCount(50);
                expect(await pressure.count()).toBeLessThanOrEqual(100);
                await candidate.getByText('Linked fleet reports (201)', {
                    exact: true,
                }).tap();
                await expect(candidate.locator('[data-retention-linked-run-row]'))
                    .toHaveCount(0);
                await expect(candidate.locator('[data-retention-linked-fleet-row]'))
                    .toHaveCount(50);
                expect(await pressure.count()).toBeLessThanOrEqual(100);
                expectPreviewOnly(fixture);
                await expectNoDocumentOverflow(page);
                expect(runtimeErrors).toEqual([]);
            } finally {
                await consequenceContext.close();
            }
        });
}

async function retentionContext(browser: Browser): Promise<BrowserContext> {
    return browser.newContext({
        baseURL: PRODUCTION_BASE_URL,
        colorScheme: 'light',
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        locale: 'en-US',
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
        viewport: { width: 932, height: 430 },
    });
}

async function traverseMonitorWindow(input: Readonly<{
    budget: number;
    itemLabel: string;
    label: string;
    rows: string;
    scope: Locator;
    total: number;
}>): Promise<void> {
    const group = input.scope.getByRole('group', {
        name: `${input.label} window`,
    });
    const rows = input.scope.locator(input.rows);
    const visited: number[] = [];
    let start = 0;
    while (true) {
        const end = Math.min(start + input.budget, input.total);
        await expect(group.getByRole('status')).toHaveText(
            `Showing ${monitorNumber(start + 1)}–${monitorNumber(end)} of ${
                monitorNumber(input.total)
            } ${input.itemLabel}.`,
        );
        await expect(rows).toHaveCount(end - start);
        expect(await rows.count()).toBeLessThanOrEqual(100);
        const ordinals = await rows.evaluateAll(nodes => nodes.map(node =>
            Number((node as HTMLElement).dataset.monitorSourceOrdinal)
        ));
        expect(ordinals).toEqual(
            Array.from({ length: end - start }, (_, offset) => start + offset),
        );
        visited.push(...ordinals);
        const next = group.getByRole('button', { name: 'Next' });
        if (await next.isDisabled()) break;
        const url = input.scope.page().url();
        await next.click();
        await expect(input.scope.page()).toHaveURL(url);
        start = end;
    }
    expect(visited).toEqual(
        Array.from({ length: input.total }, (_, ordinal) => ordinal),
    );
    expect(new Set(visited).size).toBe(input.total);
}

function monitorNumber(value: number): string {
    return value.toLocaleString('en-US');
}

function monitorDisclosure(
    page: Page,
    label: 'Timeline' | 'Events' | 'Composite results',
): Locator {
    return page.locator('[data-monitor-section="timeline"] details').filter({
        has: page.locator('summary', { hasText: `${label} (` }),
    });
}

function expectPreviewOnly(
    fixture: Awaited<ReturnType<typeof installRecipeConsoleTuneFixture>>,
): void {
    const retentionRequests = fixture.retentionRequests();
    expect(retentionRequests.map(request => request.kind)).toEqual(['preview']);
    expect(retentionRequests.filter(request =>
        request.kind === 'confirm' || request.kind === 'legacy'
    )).toEqual([]);
    expect(fixture.mutationRequestCount()).toBe(1);
}

async function expectHistoryWork(
    history: Locator,
    sourceRows: number,
    projectedRows: number,
): Promise<void> {
    const projection = history.locator('[data-history-projected-rows]');
    await expect(projection).toHaveAttribute(
        'data-history-control-run-visits',
        String(sourceRows),
    );
    await expect(projection).toHaveAttribute(
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
        await expect(projection).toHaveAttribute(attribute, String(projectedRows));
    }
}

function retentionPressureRows(page: Page): Locator {
    return page.locator([
        '[data-retention-candidate-row]',
        '[data-retention-linked-run-row]',
        '[data-retention-linked-fleet-row]',
        '[data-retention-total-id-row]',
        '[data-retention-dialog-candidate-row]',
    ].join(','));
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

function productionUrl(route: string): string {
    return new URL(route, PRODUCTION_BASE_URL).href;
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

function urlEvidenceSelectors(page: Page) {
    const params = new URL(page.url()).searchParams;
    return Object.fromEntries(
        ['agentId', 'recipeId', 'commandId'].flatMap(key => {
            const value = params.get(key);
            return value === null ? [] : [[key, value]];
        }),
    );
}

function scaleUploads(
    files: Readonly<Record<string, string>>,
): readonly AnalyzeUploadFile[] {
    return Object.entries(files).map(([name, contents]) => ({
        name,
        mimeType: name.endsWith('.jsonl')
            ? 'application/x-ndjson'
            : 'application/json',
        buffer: Buffer.from(contents),
    }));
}

function bidiUploads(identifiers: Readonly<{
    agent: string;
    recipe: string;
    command: string;
}>): readonly AnalyzeUploadFile[] {
    return createAnalyzeLooseFiles().map(file => ({
        ...file,
        buffer: Buffer.from(file.buffer.toString('utf8')
            .replaceAll(ANALYZE_AGENT_ID, identifiers.agent)
            .replaceAll(ANALYZE_RECIPE_ID, identifiers.recipe)
            .replaceAll(ANALYZE_COMMAND_ID, identifiers.command)),
    }));
}
