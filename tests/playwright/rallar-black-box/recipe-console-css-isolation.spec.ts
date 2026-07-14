import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
    FLEET_ROUTE,
    installRecipeConsoleFleetFixture,
} from './recipe-console-fleet-fixture.ts';
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
const ADVANCED_URL = RECIPE_URL.replace('view=execute', 'view=advanced');
const MATCHED_REASON = 'Agent is connected and reports the selected global group.';
const TUNE_CSS_FIXTURE = {
    retention: 'ready',
    tuneScale: {
        runCount: 120,
        commandCount: 4,
        initial: true,
    },
} as const;

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
        controlRunSelect: await style(targets.locator(
            '[data-execute-control-run-picker] [data-searchable-listbox-trigger]',
        ), [
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

async function captureRealFleetStyles(page: Page) {
    const workspace = page.locator('[data-fleet-workspace]');
    const operational = workspace.locator('[data-fleet-operational-state="live"]');
    const summary = workspace.getByRole('region', { name: 'Fleet status' });
    const liveBoard = workspace.getByRole('region', { name: 'Live agent board' });
    const map = workspace.getByRole('region', { name: 'Fleet evidence map' });
    const mapLayer = map.locator('[data-fleet-map-layer="live-agents"]');
    const artifact = workspace.getByRole('region', {
        name: 'Selected report artifact',
    });
    for (const owner of [
        workspace,
        operational,
        summary,
        liveBoard,
        map,
        mapLayer,
        artifact,
    ]) {
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
        workspace: await style(workspace, [
            'display', 'gap', 'min-width', 'overflow-y', 'padding-bottom',
        ]),
        operational: await style(operational, [
            'background-color', 'border-top-color', 'display', 'min-width',
        ]),
        summary: await style(summary, [
            'background-color', 'border-top-color', 'display', 'padding',
        ]),
        liveBoard: await style(liveBoard, [
            'background-color', 'border-top-color', 'display', 'min-width',
        ]),
        map: await style(map, [
            'background-color', 'border-top-color', 'display', 'min-width',
        ]),
        mapLayer: await style(mapLayer, [
            'background-color', 'border-radius', 'border-top-color', 'min-height',
        ]),
        artifact: await style(artifact, [
            'background-color', 'border-top-color', 'display', 'min-width',
        ]),
    };
}

async function captureRealAdvancedStyles(page: Page) {
    const workspace = page.locator('[data-advanced-workspace]');
    const context = workspace.locator('[data-advanced-context]');
    const contextGrid = context.locator('dl');
    const providerRow = context.locator('[data-context-field="provider"]');
    const catalog = workspace.locator('[data-advanced-catalog]');
    const category = catalog.locator(
        '[data-advanced-category="direct-diagnostics"]',
    );
    const surfaceLink = category.locator('[data-surface-id="direct.auth"]');
    const routeLabel = surfaceLink.locator('span').nth(1);
    for (const owner of [
        workspace,
        context,
        contextGrid,
        providerRow,
        catalog,
        category,
        surfaceLink,
        routeLabel,
    ]) {
        await expect(owner).toBeVisible();
    }
    await expect(workspace.locator('[data-advanced-category]')).toHaveCount(3);
    await expect(workspace.locator('[data-advanced-surface-link]')).toHaveCount(22);

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
        workspace: await style(workspace, [
            'display', 'gap', 'min-width', 'padding-bottom',
        ]),
        context: await style(context, [
            'background-color', 'border-bottom-color', 'border-top-color',
            'display', 'min-width',
        ]),
        contextGrid: await style(contextGrid, [
            'border-top-color', 'display', 'grid-template-columns', 'min-width',
        ]),
        providerRow: await style(providerRow, [
            'background-color', 'border-bottom-color', 'border-right-color',
            'display', 'grid-template-columns', 'padding',
        ]),
        catalog: await style(catalog, [
            'display', 'gap', 'min-width',
        ]),
        category: await style(category, [
            'background-color', 'border-bottom-color', 'border-top-color',
            'min-width',
        ]),
        surfaceLink: await style(surfaceLink, [
            'background-color', 'border-radius', 'color', 'display',
            'grid-template-columns', 'min-height', 'padding',
        ]),
        routeLabel: await style(routeLabel, [
            'color', 'font-family', 'font-size', 'line-height', 'overflow-wrap',
        ]),
    };
}

async function openTuneBaselineRunPopup(page: Page) {
    const picker = page.getByRole('group', {
        name: 'Baseline run',
        exact: true,
    });
    const trigger = picker.getByRole('button', {
        name: /^Baseline run\b/u,
    });
    await expect(picker).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();

    const search = picker.getByRole('combobox', {
        name: 'Search Baseline run',
        exact: true,
    });
    const listbox = picker.getByRole('listbox', {
        name: 'Baseline run options',
        exact: true,
    });
    const option = listbox.getByRole('option').first();
    const popup = listbox.locator('..');
    const windowControls = picker.getByRole('group', {
        name: 'Baseline run options window',
        exact: true,
    });
    const previous = windowControls.getByRole('button', {
        name: 'Previous',
        exact: true,
    });
    const next = windowControls.getByRole('button', {
        name: 'Next',
        exact: true,
    });
    for (const owner of [
        popup,
        search,
        listbox,
        option,
        windowControls,
        previous,
        next,
    ]) {
        await expect(owner).toBeVisible();
    }
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    return {
        picker,
        trigger,
        popup,
        search,
        listbox,
        option,
        windowControls,
        previous,
        next,
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
    const runPicker = await openTuneBaselineRunPopup(page);
    const runPickerStyles = {
        popup: await style(runPicker.popup, [
            'background-color', 'border-radius', 'border-top-color', 'box-shadow',
            'display', 'max-height', 'overflow', 'padding', 'position', 'z-index',
        ]),
        trigger: await style(runPicker.trigger, [
            'background-color', 'border-radius', 'border-top-color', 'color',
            'display', 'min-height', 'padding',
        ]),
        search: await style(runPicker.search, [
            'background-color', 'border-radius', 'border-top-color', 'color',
            'min-height', 'padding',
        ]),
        option: await style(runPicker.option, [
            'background-color', 'border-radius', 'border-top-color', 'color',
            'display', 'min-height', 'padding', 'width',
        ]),
        windowControls: await style(runPicker.windowControls, [
            'display', 'gap', 'grid-template-columns', 'min-width',
        ]),
        windowPrevious: await style(runPicker.previous, [
            'background-color', 'border-radius', 'border-top-color', 'color',
            'cursor', 'font-weight', 'min-height', 'padding',
        ]),
        windowNext: await style(runPicker.next, [
            'background-color', 'border-radius', 'border-top-color', 'color',
            'cursor', 'font-weight', 'min-height', 'padding',
        ]),
    };
    await page.keyboard.press('Escape');
    await expect(runPicker.trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('listbox', {
        name: 'Baseline run options',
        exact: true,
    })).toHaveCount(0);
    await expect(page.locator('[data-searchable-listbox-popup]')).toHaveCount(0);

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
        runPicker: runPickerStyles,
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
    await installRecipeConsoleTuneFixture(context, TUNE_CSS_FIXTURE);
    await page.goto(TUNE_COMPARE_ROUTE);
    const before = await captureRealTuneStyles(page);

    const leavingPopup = await openTuneBaselineRunPopup(page);
    await expect(leavingPopup.popup).toBeVisible();

    await navigateInApp(page, '/?provider=simulated&experience=legacy&tab=auth');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('[data-tune-workspace]')).toHaveCount(0);
    await expect(page.getByRole('listbox', {
        name: 'Baseline run options',
        exact: true,
    })).toHaveCount(0);
    await expect(page.locator('[data-searchable-listbox-popup]')).toHaveCount(0);
    await navigateInApp(page, TUNE_COMPARE_ROUTE);
    await expect(page.locator('.app-shell')).toHaveCount(0);

    expect(await captureRealTuneStyles(page)).toEqual(before);
});

test('matches cold Tune styles when legacy components load first', async ({
    context,
    page,
}) => {
    await installRecipeConsoleTuneFixture(context, TUNE_CSS_FIXTURE);
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

test('matches cold Fleet styles when legacy Fleet loads first', async ({
    context,
    page,
}) => {
    await installRecipeConsoleFleetFixture(context, page);
    await page.goto(FLEET_ROUTE);
    const coldFleet = await captureRealFleetStyles(page);

    const legacyFirst = await context.newPage();
    await installRecipeConsoleFleetFixture(context, legacyFirst);
    await legacyFirst.goto(
        '/?provider=simulated&experience=legacy' +
        '&workspace=black-box-runner&tab=fleet',
    );
    await expect(legacyFirst.locator('.runner-fleet-panel')).toBeVisible();
    await expect(legacyFirst.locator('[data-fleet-workspace]')).toHaveCount(0);
    await navigateInApp(legacyFirst, FLEET_ROUTE);
    await expect(legacyFirst.locator('.app-shell')).toHaveCount(0);

    expect(await captureRealFleetStyles(legacyFirst)).toEqual(coldFleet);
    await legacyFirst.close();
});

test('preserves real Advanced styles across a Recipe-first legacy round trip',
    async ({ context, page }) => {
        await routeLiveExecuteControl(context);
        await page.goto(ADVANCED_URL);
        const before = await captureRealAdvancedStyles(page);

        await navigateInApp(
            page,
            '/?provider=simulated&experience=legacy&workspace=rallar&tab=auth',
        );
        await expect(page.locator('#panel-auth')).toBeVisible();
        await expect(page.locator('[data-advanced-workspace]')).toHaveCount(0);

        await navigateInApp(page, ADVANCED_URL);
        await expect(page.locator('.app-shell')).toHaveCount(0);
        expect(await captureRealAdvancedStyles(page)).toEqual(before);
    });

test('matches cold Advanced styles when legacy components load first', async ({
    context,
    page,
}) => {
    await routeLiveExecuteControl(context);
    await page.goto(ADVANCED_URL);
    const coldAdvanced = await captureRealAdvancedStyles(page);

    const legacyFirst = await context.newPage();
    await legacyFirst.goto(
        '/?provider=simulated&experience=legacy&workspace=rallar&tab=auth',
    );
    await expect(legacyFirst.locator('#panel-auth')).toBeVisible();
    await expect(legacyFirst.locator('[data-advanced-workspace]')).toHaveCount(0);
    await navigateInApp(legacyFirst, ADVANCED_URL);
    await expect(legacyFirst.locator('.app-shell')).toHaveCount(0);

    expect(await captureRealAdvancedStyles(legacyFirst)).toEqual(coldAdvanced);
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

test('lazy-loads Fleet on demand and leaves no inactive artifact owner', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleFleetFixture(context, page);
    const fleetModuleRequests: string[] = [];
    page.on('request', request => {
        if (request.url().includes('/recipe-console/fleet/')) {
            fleetModuleRequests.push(request.url());
        }
    });
    const executeRoute = FLEET_ROUTE.replace('view=fleet', 'view=execute');

    await page.goto(executeRoute);
    await expect(page.locator('.recipe-console')).toHaveAttribute(
        'data-view',
        'execute',
    );
    await expect(page.locator('[data-fleet-workspace]')).toHaveCount(0);
    expect(fleetModuleRequests).toEqual([]);
    expect(fixture.artifactRequestCount()).toBe(0);

    await page.getByRole('button', { name: 'Fleet', exact: true }).click();
    const fleet = page.locator('[data-fleet-workspace]');
    await expect(fleet.locator('[data-fleet-operational-state="live"]'))
        .toBeVisible();
    expect(fleetModuleRequests.some(url => url.includes('FleetWorkspace.tsx')))
        .toBe(true);
    await fleet.getByRole('button', { name: 'Load artifact bundle' }).click();
    await expect.poll(fixture.artifactRequestCount).toBe(1);

    const fleetRequestsAtLeave = fleetModuleRequests.length;
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await expect(page.locator('.recipe-console')).toHaveAttribute(
        'data-view',
        'execute',
    );
    await expect(page.locator('[data-fleet-workspace]')).toHaveCount(0);
    await expect(page.getByRole('region', {
        name: 'Selected report artifact',
    })).toHaveCount(0);

    const rootRequestsBeforeRefresh = fixture.rootRequestCount();
    await page.getByRole('button', { name: 'Refresh control data' }).click();
    await expect.poll(fixture.rootRequestCount)
        .toBeGreaterThan(rootRequestsBeforeRefresh);
    expect(fixture.artifactRequestCount()).toBe(1);
    expect(fleetModuleRequests).toHaveLength(fleetRequestsAtLeave);
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
