import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
    installRecipeConsoleMonitorFixture,
    MONITOR_ROUTE,
} from './recipe-console-monitor-fixture.ts';
import { installRecipeConsoleTuneFixture } from './recipe-console-tune-fixture.ts';
import { TUNE_COMPARE_ROUTE } from './recipe-console-tune-run-data.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const RECIPE_URL =
    '/?provider=simulated&v=1&experience=recipe-console&view=execute' +
    '&controlRunId=execute-control-a';
const MATCHED_REASON = 'Agent is connected and reports the selected global group.';

const legacySelectors = [
    '[data-isolation-legacy-panel]',
    '[data-isolation-legacy-pill]',
    '[data-isolation-legacy-metric]',
    '[data-isolation-legacy-form]',
    '[data-isolation-legacy-table]',
    '[data-isolation-legacy-dialog]',
] as const;
const recipeSelectors = [
    '[data-isolation-recipe-surface]',
    '[data-isolation-recipe-button]',
    '[data-isolation-recipe-status] [data-status="failed"]',
    '[data-isolation-recipe-form]',
    '[data-isolation-recipe-table]',
    '[data-isolation-recipe-dialog] [data-inspector-host]',
] as const;

async function capture(
    page: Page,
    mode: string,
    selectors: readonly string[],
    fixture = '/test/fixtures/recipe-console-css-isolation.html',
) {
    const requests: string[] = [];
    const listener = (request: import('@playwright/test').Request) => requests.push(request.url());
    page.on('request', listener);
    await page.goto(`${fixture}?mode=${mode}`);
    const styles = await Promise.all(selectors.map(async selector => {
        const element = page.locator(selector);
        await expect(element, selector).toHaveCount(1);
        return element.evaluate(node => {
            const style = getComputedStyle(node);
            return {
                backgroundColor: style.backgroundColor,
                borderRadius: style.borderRadius,
                borderTopColor: style.borderTopColor,
                color: style.color,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                padding: style.padding,
            };
        });
    }));
    page.off('request', listener);
    return { requests, styles };
}

function liveExecuteSnapshot() {
    const runId = 'execute-control-a';
    const evidenceAtEpochMs = Date.now();
    const group = {
        applicationId: 'rallar-black-box',
        workspaceId: 'default',
        groupId: 'rallar-black-box-room',
    } as const;
    const agents = ['execute-agent-a', 'execute-agent-b'].map(agentId => ({
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

async function routeLiveExecuteControl(context: BrowserContext): Promise<void> {
    await context.route(CONTROL_ROUTE, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(liveExecuteSnapshot()),
    }));
}

async function navigateInApp(page: Page, url: string): Promise<void> {
    await page.evaluate(nextUrl => {
        history.pushState({}, '', nextUrl);
        dispatchEvent(new PopStateEvent('popstate'));
    }, url);
}

async function captureRealRecipeStyles(page: Page) {
    const catalog = page.getByRole('region', { name: 'Recipe ledger' });
    const targets = page.getByRole('region', { name: 'Targets' });
    const actionBand = page.getByRole('region', { name: 'Execute actions' });
    const targetRow = targets.locator('[data-target-status="matched"]').first();
    await expect(catalog).toBeVisible();
    await expect(targets).toBeVisible();
    await expect(actionBand).toBeVisible();
    await expect(targetRow).toBeVisible();

    const style = async (selector: ReturnType<Page['locator']>, properties: readonly string[]) =>
        selector.evaluate((node, names) => {
            const computed = getComputedStyle(node);
            return Object.fromEntries(names.map(name => [name, computed.getPropertyValue(name)]));
        }, properties);

    return {
        catalog: await style(catalog, [
            'background-color', 'border-top-color', 'display', 'grid-template-rows',
        ]),
        targets: await style(targets, [
            'background-color', 'border-top-color', 'display', 'min-width',
        ]),
        actionBand: await style(actionBand, [
            'background-color', 'border-top-color', 'display', 'grid-template-columns',
        ]),
        controlRunSelect: await style(targets.getByRole('combobox', {
            name: 'Control run',
        }), [
            'background-color', 'border-radius', 'border-top-color', 'min-height',
        ]),
        checkbox: await style(targetRow.getByRole('checkbox'), [
            'accent-color', 'height', 'width',
        ]),
        status: await style(targetRow.locator('[data-status="passed"]'), [
            'background-color', 'border-top-color', 'border-radius', 'color', 'padding',
        ]),
        reason: await style(targetRow.getByText(MATCHED_REASON, { exact: true }), [
            'color', 'font-size', 'line-height', 'overflow', 'white-space',
        ]),
    };
}

async function captureRealMonitorStyles(page: Page) {
    const verdict = page.locator('[data-monitor-section="verdict"]');
    const failure = page.locator('[data-failure-key]').first();
    const matrix = page.locator('[data-monitor-section="matrix"]');
    const evidence = page.locator('[data-monitor-section="timeline"] summary').first();
    const actions = page.locator('[data-monitor-section="actions"]');
    const inspector = page.locator('[data-monitor-inspector]');
    for (const owner of [verdict, failure, matrix, evidence, actions, inspector]) {
        await expect(owner).toBeVisible();
    }
    const style = async (
        owner: ReturnType<Page['locator']>,
        properties: readonly string[],
    ) => owner.evaluate((node, names) => {
        const computed = getComputedStyle(node);
        return Object.fromEntries(names.map(name => [
            name,
            computed.getPropertyValue(name),
        ]));
    }, properties);
    return {
        verdict: await style(verdict, [
            'background-color', 'border-top-color', 'display', 'padding',
        ]),
        failure: await style(failure, [
            'background-color', 'border-left-color', 'min-height', 'display',
        ]),
        matrix: await style(matrix, [
            'background-color', 'border-top-color', 'display', 'min-width',
        ]),
        evidence: await style(evidence, [
            'background-color', 'min-height', 'padding', 'font-weight',
        ]),
        actions: await style(actions, [
            'background-color', 'border-top-color', 'display', 'position',
        ]),
        inspector: await style(inspector, [
            'display', 'min-width', 'overflow-wrap', 'padding',
        ]),
    };
}

async function captureRealTuneStyles(page: Page) {
    const source = page.locator('[data-tune-source]');
    const hints = page.locator('[data-tune-hints]');
    const commandTiming = page.locator('[data-tune-command-timing]');
    const streamHealth = page.locator('[data-tune-stream-health]');
    const candidate = page.locator('[data-tune-candidate]');
    const comparison = page.locator('[data-tune-comparison]');
    const candidateInput = candidate.getByLabel('Candidate value');
    const metric = source.getByRole('button', {
        name: 'Send duration',
        exact: true,
    });
    const history = page.locator('[data-history-workspace]');
    const filters = history.locator('[data-history-filters]');
    const savedFilters = history.locator('[data-history-saved-filters]');
    const historyTable = history.getByRole('region', {
        name: 'Recipe run history',
    });
    const retention = history.locator('[data-retention-panel]');
    const retentionPreview = retention.getByRole('button', {
        name: 'Preview cleanup',
        exact: true,
    });
    for (const owner of [
        source,
        hints,
        commandTiming,
        streamHealth,
        candidate,
        comparison,
        candidateInput,
        metric,
        history,
        filters,
        savedFilters,
        historyTable,
        retention,
        retentionPreview,
    ]) {
        await expect(owner).toBeVisible();
    }
    await expect(metric).toHaveAttribute('aria-pressed', 'true');

    const style = async (
        owner: ReturnType<Page['locator']>,
        properties: readonly string[],
    ) => owner.evaluate((node, names) => {
        const computed = getComputedStyle(node);
        return Object.fromEntries(names.map(name => [
            name,
            computed.getPropertyValue(name),
        ]));
    }, properties);
    const panelProperties = [
        'background-color', 'border-top-color', 'display', 'min-width', 'padding',
    ] as const;
    await retentionPreview.evaluate(button => {
        button.setAttribute('disabled', '');
    });
    const disabledRetentionAction = await style(retentionPreview, [
        'cursor', 'opacity',
    ]);
    await retentionPreview.evaluate(button => {
        button.removeAttribute('disabled');
    });
    if (await history.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    }).count() === 0) {
        await history.getByRole('button', {
            name: 'Preview cleanup',
            exact: true,
        }).click();
    }
    await history.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    }).click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Delete previewed runs?',
    });
    await expect(dialog).toBeVisible();
    const result = {
        source: await style(source, panelProperties),
        hints: await style(hints, panelProperties),
        commandTiming: await style(commandTiming, panelProperties),
        streamHealth: await style(streamHealth, panelProperties),
        candidate: await style(candidate, panelProperties),
        comparison: await style(comparison, panelProperties),
        candidateInput: await style(candidateInput, [
            'background-color', 'border-radius', 'border-top-color', 'color',
            'min-height',
        ]),
        metric: await style(metric, [
            'background-color', 'border-radius', 'border-top-color', 'color',
            'font-weight', 'min-height',
        ]),
        history: await style(history, panelProperties),
        filters: await style(filters, panelProperties),
        savedFilters: await style(savedFilters, panelProperties),
        historyTable: await style(historyTable, [
            'border-top-color', 'display', 'max-width', 'overflow-x',
        ]),
        retention: await style(retention, panelProperties),
        disabledRetentionAction,
        dialog: await style(dialog, [
            'background-color', 'border-top-color', 'display', 'max-height',
            'overflow', 'padding',
        ]),
    };
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    return result;
}

test('is independent of stylesheet load order', async ({ page }) => {
    const legacyFirstLegacy = await capture(page, 'both', legacySelectors);
    const legacyFirstRecipe = await capture(page, 'both', recipeSelectors);
    const recipeFirstLegacy = await capture(
        page,
        'both',
        legacySelectors,
        '/test/fixtures/recipe-console-css-isolation-recipe-first.html',
    );
    const recipeFirstRecipe = await capture(
        page,
        'both',
        recipeSelectors,
        '/test/fixtures/recipe-console-css-isolation-recipe-first.html',
    );

    expect(recipeFirstLegacy.styles).toEqual(legacyFirstLegacy.styles);
    expect(recipeFirstRecipe.styles).toEqual(legacyFirstRecipe.styles);
});

test('survives Recipe Console to legacy to Recipe Console navigation', async ({
    context,
    page,
}) => {
    await routeLiveExecuteControl(context);
    await page.goto(RECIPE_URL);
    const before = await captureRealRecipeStyles(page);

    await navigateInApp(page, '/?provider=simulated&experience=legacy&tab=auth');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);

    await navigateInApp(page, RECIPE_URL);
    await expect(page.locator('.app-shell')).toHaveCount(0);
    const after = await captureRealRecipeStyles(page);
    expect(after).toEqual(before);
});

test('matches cold Recipe styles when legacy components load first', async ({
    context,
    page,
}) => {
    await routeLiveExecuteControl(context);
    await page.goto(RECIPE_URL);
    const coldRecipe = await captureRealRecipeStyles(page);

    const legacyFirst = await context.newPage();
    await legacyFirst.goto('/?provider=simulated&experience=legacy&tab=auth');
    await expect(legacyFirst.locator('.app-shell')).toBeVisible();
    await expect(legacyFirst.locator('.recipe-console')).toHaveCount(0);
    await navigateInApp(legacyFirst, RECIPE_URL);
    await expect(legacyFirst.locator('.app-shell')).toHaveCount(0);

    expect(await captureRealRecipeStyles(legacyFirst)).toEqual(coldRecipe);
    await legacyFirst.close();
});

test('preserves live Monitor styles across a legacy round trip', async ({
    context,
    page,
}) => {
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);
    const before = await captureRealMonitorStyles(page);

    await navigateInApp(page, '/?provider=simulated&experience=legacy&tab=auth');
    await expect(page.locator('.app-shell')).toBeVisible();
    await navigateInApp(page, MONITOR_ROUTE);
    await expect(page.locator('.app-shell')).toHaveCount(0);

    expect(await captureRealMonitorStyles(page)).toEqual(before);
});

test('matches cold Monitor styles when legacy components load first', async ({
    context,
    page,
}) => {
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);
    const coldMonitor = await captureRealMonitorStyles(page);

    const legacyFirst = await context.newPage();
    await legacyFirst.goto('/?provider=simulated&experience=legacy&tab=auth');
    await expect(legacyFirst.locator('.app-shell')).toBeVisible();
    await navigateInApp(legacyFirst, MONITOR_ROUTE);
    await expect(legacyFirst.locator('.app-shell')).toHaveCount(0);

    expect(await captureRealMonitorStyles(legacyFirst)).toEqual(coldMonitor);
    await legacyFirst.close();
});

test('preserves real Tune styles across a legacy round trip', async ({
    context,
    page,
}) => {
    await installRecipeConsoleTuneFixture(context, { retention: 'ready' });
    await page.goto(TUNE_COMPARE_ROUTE);
    const before = await captureRealTuneStyles(page);

    await navigateInApp(page, '/?provider=simulated&experience=legacy&tab=auth');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('[data-tune-workspace]')).toHaveCount(0);
    await navigateInApp(page, TUNE_COMPARE_ROUTE);
    await expect(page.locator('.app-shell')).toHaveCount(0);

    expect(await captureRealTuneStyles(page)).toEqual(before);
});

test('matches cold Tune styles when legacy components load first', async ({
    context,
    page,
}) => {
    await installRecipeConsoleTuneFixture(context, { retention: 'ready' });
    await page.goto(TUNE_COMPARE_ROUTE);
    const coldTune = await captureRealTuneStyles(page);

    const legacyFirst = await context.newPage();
    await legacyFirst.goto('/?provider=simulated&experience=legacy&tab=auth');
    await expect(legacyFirst.locator('.app-shell')).toBeVisible();
    await expect(legacyFirst.locator('[data-tune-workspace]')).toHaveCount(0);
    await navigateInApp(legacyFirst, TUNE_COMPARE_ROUTE);
    await expect(legacyFirst.locator('.app-shell')).toHaveCount(0);

    expect(await captureRealTuneStyles(legacyFirst)).toEqual(coldTune);
    await legacyFirst.close();
});

test('lazy-loads Tune only on demand and unmounts it when leaving', async ({
    context,
    page,
}) => {
    await installRecipeConsoleTuneFixture(context, { retention: 'ready' });
    const tuneModuleRequests: string[] = [];
    const historyModuleRequests: string[] = [];
    const retentionModuleRequests: string[] = [];
    page.on('request', request => {
        if (request.url().includes('/recipe-console/tune/')) {
            tuneModuleRequests.push(request.url());
        }
        if (request.url().includes('/recipe-console/history/')) {
            historyModuleRequests.push(request.url());
        }
        if (/control-retention-(?:api|request|validation)/.test(request.url())) {
            retentionModuleRequests.push(request.url());
        }
    });

    await page.goto(RECIPE_URL);
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'execute');
    await expect(page.locator('[data-tune-workspace]')).toHaveCount(0);
    await expect(page.locator('[data-history-workspace]')).toHaveCount(0);
    await expect(page.locator('[data-retention-panel]')).toHaveCount(0);
    expect(tuneModuleRequests).toEqual([]);
    expect(historyModuleRequests).toEqual([]);
    expect(retentionModuleRequests).toEqual([]);

    await page.getByRole('button', { name: 'Tune', exact: true }).click();
    await expect(page.locator('[data-tune-workspace]')).toBeVisible();
    await expect(page.locator('[data-history-workspace]')).toBeVisible();
    await expect(page.locator('[data-retention-panel]')).toBeVisible();
    expect(tuneModuleRequests.some(url => url.includes('TuneWorkspace.tsx'))).toBe(true);
    expect(historyModuleRequests.some(url => url.includes('HistoryWorkspace.tsx')))
        .toBe(true);
    expect(retentionModuleRequests).toEqual([]);

    await page.getByRole('button', {
        name: 'Preview cleanup',
        exact: true,
    }).click();
    await expect.poll(() => retentionModuleRequests.length).toBeGreaterThan(0);
    expect(retentionModuleRequests.some(url =>
        url.includes('control-retention-api.ts')
    )).toBe(true);
    await page.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    }).click();
    await expect(page.getByRole('alertdialog', {
        name: 'Delete previewed runs?',
    })).toBeVisible();

    await navigateInApp(page, RECIPE_URL);
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'execute');
    await expect(page.locator('[data-tune-workspace]')).toHaveCount(0);
    await expect(page.locator('[data-history-workspace]')).toHaveCount(0);
    await expect(page.locator('[data-retention-panel]')).toHaveCount(0);
    await expect(page.locator('[data-retention-confirm-dialog]')).toHaveCount(0);
});

test('keeps complete target status evidence reachable across Execute viewports', async ({
    context,
    page,
}) => {
    await routeLiveExecuteControl(context);
    for (const contract of [
        { name: 'desktop', viewport: { width: 1440, height: 900 }, overflow: false },
        { name: 'portrait', viewport: { width: 430, height: 932 }, overflow: true },
        { name: 'short landscape', viewport: { width: 932, height: 430 }, overflow: false },
    ] as const) {
        await page.setViewportSize(contract.viewport);
        await page.goto(RECIPE_URL);

        const targets = page.getByRole('region', { name: 'Targets' });
        const scroller = targets.getByRole('region', { name: 'Target evidence table' });
        const row = targets.locator('[data-target-status="matched"]').first();
        const status = row.locator('[data-status="passed"]');
        const reason = row.getByText(MATCHED_REASON, { exact: true });
        await expect(scroller, `${contract.name} target scroller`).toHaveAttribute(
            'tabindex',
            '0',
        );
        await expect(status, `${contract.name} matched status`).toBeVisible();
        await expect(reason, `${contract.name} full target reason`).toHaveText(MATCHED_REASON);

        const overflow = await scroller.evaluate(
            element => element.scrollWidth - element.clientWidth,
        );
        if (contract.overflow) {
            expect(overflow, `${contract.name} horizontal overflow`).toBeGreaterThan(1);
            await scroller.focus();
            await expect(scroller).toBeFocused();
            await page.keyboard.press('ArrowRight');
            await expect.poll(
                () => scroller.evaluate(element => element.scrollLeft),
                { message: `${contract.name} ArrowRight scroll` },
            ).toBeGreaterThan(0);
            for (let index = 0; index < 24; index += 1) {
                await page.keyboard.press('ArrowRight');
            }
            await expect.poll(() => scroller.evaluate(element => ({
                remaining: element.scrollWidth - element.clientWidth - element.scrollLeft,
            }))).toEqual({ remaining: 0 });
        } else {
            expect(overflow, `${contract.name} horizontal overflow`).toBeLessThanOrEqual(1);
        }

        const reachability = await scroller.evaluate((element, selectors) => {
            const scrollerBounds = element.getBoundingClientRect();
            const statusNode = element.querySelector(selectors.status);
            const reasonNode = Array.from(element.querySelectorAll('span')).find(
                node => node.textContent === selectors.reason,
            );
            if (!statusNode || !reasonNode) return undefined;
            const statusBounds = statusNode.getBoundingClientRect();
            const reasonBounds = reasonNode.getBoundingClientRect();
            return {
                reasonClipped: reasonNode.scrollHeight > reasonNode.clientHeight + 1 ||
                    reasonNode.scrollWidth > reasonNode.clientWidth + 1,
                reasonRight: reasonBounds.right,
                scrollerLeft: scrollerBounds.left,
                scrollerRight: scrollerBounds.right,
                statusLeft: statusBounds.left,
            };
        }, {
            status: '[data-target-status="matched"] [data-status="passed"]',
            reason: MATCHED_REASON,
        });
        expect(reachability, `${contract.name} target evidence bounds`).toBeDefined();
        expect(reachability?.statusLeft, `${contract.name} status left edge`)
            .toBeGreaterThanOrEqual((reachability?.scrollerLeft ?? 0) - 1);
        expect(reachability?.reasonRight, `${contract.name} reason right edge`)
            .toBeLessThanOrEqual((reachability?.scrollerRight ?? 0) + 1);
        expect(reachability?.reasonClipped, `${contract.name} full reason clipping`)
            .toBe(false);
    }
});

test('keeps representative legacy and recipe console styles isolated', async ({ page }) => {
    const legacyOnly = await capture(page, 'legacy', legacySelectors);
    const recipeOnly = await capture(page, 'recipe-console', recipeSelectors);
    const mixedLegacy = await capture(page, 'both', legacySelectors);
    const mixedRecipe = await capture(page, 'both', recipeSelectors);

    expect(mixedLegacy.styles).toEqual(legacyOnly.styles);
    expect(mixedRecipe.styles).toEqual(recipeOnly.styles);
    expect(legacyOnly.requests.some(url => url.includes('tokens.css'))).toBe(false);
    expect(legacyOnly.requests.some(url => url.includes('primitives.module.css'))).toBe(false);
    expect(recipeOnly.requests.some(url => url.endsWith('/src/styles.css'))).toBe(false);
    expect(mixedLegacy.requests.some(url => url.endsWith('/src/styles.css'))).toBe(true);
    expect(mixedRecipe.requests.some(url => url.includes('tokens.css'))).toBe(true);

    await page.goto('/test/fixtures/recipe-console-css-isolation.html?mode=both');
    const recipeSurface = page.locator('[data-isolation-recipe-surface]');
    const recipeButton = page.locator('[data-isolation-recipe-button]');
    await expect(recipeSurface).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(recipeSurface).toHaveCSS('border-top-color', 'rgb(213, 219, 227)');
    await expect(recipeButton).toHaveCSS('background-color', 'rgb(36, 70, 194)');
    await expect(recipeButton).toHaveCSS('border-radius', '6px');
});
