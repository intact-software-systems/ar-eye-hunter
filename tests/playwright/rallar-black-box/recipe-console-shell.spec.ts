import { expect, test, type Page } from '@playwright/test';
import { chooseAnalyzeFiles } from './recipe-console-analyze-helpers.ts';
import {
    installRecipeConsoleMonitorFixture,
    MONITOR_DIAGNOSTIC_ID,
    MONITOR_DISTRIBUTED_RUN_ID,
    MONITOR_FAILURE_AGENT_ID,
    MONITOR_FAILURE_CODE,
    MONITOR_FAILURE_COMMAND_ID,
    MONITOR_FAILURE_MESSAGE,
    MONITOR_FAILURE_RECIPE_ID,
    MONITOR_ROUTE
} from './recipe-console-monitor-fixture.ts';
import { createTuneArtifactUpload } from './recipe-console-tune-artifacts.ts';
import { installRecipeConsoleTuneFixture } from './recipe-console-tune-fixture.ts';
import {
    TUNE_ANALYZE_ROUTE,
    TUNE_RIGHT_CONTROL_RUN_ID,
    TUNE_RIGHT_RUN_ID,
    TUNE_SLOW_AGENT_ID
} from './recipe-console-tune-run-data.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;

async function routeOfflineControl(page: Page): Promise<void> {
    await page.route(CONTROL_ROUTE, (route) => route.abort('connectionfailed'));
}

const EXECUTE_GROUP = {
    applicationId: 'rallar-black-box',
    workspaceId: 'default',
    groupId: 'rallar-black-box-room'
} as const;
const LIVE_EXECUTE_ROUTE = '/?provider=simulated&experience=recipe-console&view=execute' +
    '&applicationId=rallar-black-box&workspaceId=default' +
    '&roomId=rallar-black-box-room';

function liveExecuteSnapshot() {
    const runId = 'execute-control-a';
    const now = Date.now();
    const agents = ['execute-agent-a', 'execute-agent-b'].map((agentId) => ({
        runId,
        agentId,
        connected: true,
        registeredAtEpochMs: now - 2_000,
        lastSeenAtEpochMs: now - 500,
        lastHeartbeatAtEpochMs: now - 500,
        status: 'connected',
        identity: {
            principalId: `${agentId}-principal`,
            sessionId: `${agentId}-session`,
            ...EXECUTE_GROUP,
            providerMode: 'browser-rallar',
            browserName: 'chromium',
            region: 'eu-north'
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: []
    }));
    return {
        runs: [{
            runId,
            createdAtEpochMs: now - 10_000,
            updatedAtEpochMs: now - 500,
            agents,
            commands: [],
            results: [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: []
        }],
        distributedRuns: []
    };
}

async function routeLiveExecuteControl(page: Page): Promise<void> {
    await page.route(CONTROL_ROUTE, async (route) => {
        const snapshot = liveExecuteSnapshot();
        const pathname = new URL(route.request().url()).pathname;
        const runId = /^\/runs\/([^/]+)$/.exec(pathname)?.[1];
        const run = runId
            ? snapshot.runs.find((candidate) => candidate.runId === decodeURIComponent(runId))
            : undefined;
        await route.fulfill({
            status: runId && !run ? 404 : 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(runId ? run ?? { error: 'Control run not found.' } : snapshot)
        });
    });
}

test('renders real Tune evidence without invented values', async ({ context, page }) => {
    await page.setViewportSize({ width: 932, height: 430 });
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, [createTuneArtifactUpload()]);
    await page.getByRole('button', { name: 'Tune', exact: true }).click();

    await expect(page.locator('[data-command-bar]')).toHaveCSS('height', '48px');
    expect((await page.locator('[data-primary-navigation]').boundingBox())?.width).toBe(60);
    const commandBar = page.locator('[data-command-bar]');
    await expect(commandBar.locator('[data-status="passed"]'))
        .toContainText('Live · reachable');
    await expect(commandBar).toContainText('Control server');
    await expect(commandBar).toContainText('http://localhost:5180');
    await expect(commandBar).toContainText(
        'rallar-server/default/tune-ci'
    );
    await expect(commandBar).not.toContainText('Baseline');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    const tune = page.locator('[data-tune-workspace]');
    await expect(tune).toHaveAttribute('data-source-kind', 'artifact');
    await expect(tune).toHaveAttribute('data-source-detail', 'detailed');
    const commandTiming = tune.locator('[data-tune-command-timing]');
    for (const percentile of ['P50 400 ms', 'P95 1,200 ms', 'P99 1,200 ms']) {
        await expect(commandTiming).toContainText(percentile);
    }
    const streamHealth = tune.locator('[data-tune-stream-health]');
    for (
        const evidence of [
            '30 planned',
            '28 scheduled',
            '23 attempted',
            '22 completed',
            '1 failed',
            '5 dropped',
            '2 in-flight drops',
            '30 Hz requested',
            '28 Hz scheduled',
            '22 Hz completed',
            '28 ms max drift',
            '6 late',
            '4 backpressure',
            'P95 68 ms',
            'P99 92 ms',
            TUNE_SLOW_AGENT_ID
        ]
    ) {
        await expect(streamHealth).toContainText(evidence);
    }
    await expect(tune.locator('[data-tune-hints]')).toContainText('Lower cadence');

    const drift = page.getByRole('button', { name: 'Drift', exact: true });
    await drift.focus();
    await page.keyboard.press('Enter');
    await expect(drift).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/timingMetric=stream-drift/);

    const slowStream = streamHealth.locator('[data-tune-slow-agents="stream"] button')
        .filter({ hasText: TUNE_SLOW_AGENT_ID });
    await slowStream.focus();
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    await expect(inspector.locator('[data-tune-inspector]'))
        .toContainText(TUNE_SLOW_AGENT_ID);
    const close = inspector.getByRole('button', { name: 'Close inspector' });
    await expect(close).toBeFocused();
    const legacyLink = inspector.getByRole('link', {
        name: 'Open this run in legacy Runs'
    });
    const legacyUrl = new URL(await legacyLink.getAttribute('href') ?? '', page.url());
    expect(legacyUrl.searchParams.get('experience')).toBe('legacy');
    expect(legacyUrl.searchParams.get('workspace')).toBe('black-box-runner');
    expect(legacyUrl.searchParams.get('tab')).toBe('runs');
    expect(legacyUrl.searchParams.get('controlRunId')).toBe(TUNE_RIGHT_CONTROL_RUN_ID);
    expect(legacyUrl.searchParams.get('distributedRunId')).toBe(TUNE_RIGHT_RUN_ID);
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(slowStream).toBeFocused();
    expect(
        await page.evaluate(() => ({
            x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            y: document.documentElement.scrollHeight - document.documentElement.clientHeight
        }))
    ).toEqual({ x: 0, y: 0 });
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);

    await slowStream.press('Enter');
    const activeLegacyLink = page.getByRole('dialog', {
        name: 'Inspector'
    }).getByRole('link', {
        name: 'Open this run in legacy Runs'
    });
    await activeLegacyLink.focus();
    await activeLegacyLink.press('Enter');
    await expect(page).toHaveURL(/experience=legacy/);
    await expect(page).toHaveURL(/workspace=black-box-runner/);
    await expect(page).toHaveURL(/tab=runs/);
    const legacyRuns = page.locator('#panel-runs');
    await expect(legacyRuns).toBeVisible();
    await expect(legacyRuns.getByRole('combobox', { name: 'Distributed Run' }))
        .toHaveValue(TUNE_RIGHT_RUN_ID);
    await expect(legacyRuns.locator('.runner-distributed-freshness'))
        .toContainText(TUNE_RIGHT_CONTROL_RUN_ID);
    await expect(legacyRuns.locator('.distributed-run-summary'))
        .toContainText('failed');
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('routes bounded Analyze Fleet and Advanced workspaces', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/?provider=simulated&experience=recipe-console&view=analyze');
    const initialHistoryLength = await page.evaluate(() => history.length);

    const analyze = page.locator('[data-analyze-workspace]');
    const analyzeSource = analyze.locator('[data-analyze-source]');
    await expect(analyze).toBeVisible();
    await expect(analyzeSource).toBeVisible();
    await expect(analyzeSource.getByRole('heading', {
        name: 'Import offline or load from Control'
    })).toBeVisible();
    await expect(analyzeSource.getByText('Choose files', { exact: true })).toBeVisible();
    await expect(analyzeSource.locator('[data-analyze-file-input]')).toBeAttached();
    await expect(analyze.getByRole('heading', {
        name: 'Import distributed-run evidence'
    })).toBeVisible();
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Fleet', exact: true }).click();
    await expect(page).toHaveURL(/view=fleet/);
    await expect(page.locator('[data-analyze-workspace]')).toHaveCount(0);
    const offlineFleet = page.locator('[data-fleet-operational-state="offline"]');
    await expect(offlineFleet.getByRole('heading', {
        name: 'Fleet control is offline'
    }))
        .toBeVisible();
    await expect(offlineFleet.getByText(
        'No current snapshot is available. Reconnect or use the operational legacy fallback.',
        { exact: true }
    ))
        .toBeVisible();
    await expect(offlineFleet).toContainText('Fleet report collection unavailable.');
    await expect(page.locator('[data-preview-view="fleet"] [data-fleet-region]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(page).toHaveURL(/view=advanced/);
    await expect(page.locator('[data-analyze-workspace]')).toHaveCount(0);
    const advanced = page.locator('[data-preview-view="advanced"]');
    await expect(advanced.getByRole('heading', { name: 'Current diagnostic context' }))
        .toBeVisible();
    for (
        const heading of [
            'Direct Diagnostics',
            'Preserved Workflow Fallbacks',
            'Advanced Legacy'
        ]
    ) {
        await expect(advanced.getByRole('heading', { name: heading }))
            .toBeVisible();
    }
    const advancedLinks = advanced.locator('[data-advanced-surface-link]');
    await expect(advancedLinks).toHaveCount(22);
    for (
        const [label, route] of [
            ['Auth', { workspace: 'rallar', tab: 'auth', surface: 'direct.auth' }],
            ['Runs', {
                workspace: 'black-box-runner',
                tab: 'runs',
                surface: 'runner.runs'
            }],
            ['Shared Test', {
                workspace: 'black-box-runner',
                tab: 'advanced',
                advancedSurface: 'shared-test',
                surface: 'legacy.shared-test-catalog'
            }]
        ] as const
    ) {
        const href = await advanced.getByRole('link', { name: new RegExp(`^${label}`) })
            .getAttribute('href');
        const target = new URL(href ?? '', page.url());
        expect(target.searchParams.get('experience')).toBe('legacy');
        expect(target.searchParams.get('workspace')).toBe(route.workspace);
        expect(target.searchParams.get('tab')).toBe(route.tab);
        expect(target.searchParams.get('legacySurface')).toBe(route.surface);
        expect(target.searchParams.get('diagnosticContext')).toBe('1');
        expect(target.searchParams.get('provider')).toBe('simulated');
        if ('advancedSurface' in route) {
            expect(target.searchParams.get('advancedSurface'))
                .toBe(route.advancedSurface);
        }
    }
    await expect(page.locator('.app-shell')).toHaveCount(0);
    expect(await page.evaluate(() => history.length)).toBeGreaterThanOrEqual(initialHistoryLength + 2);

    await page.goBack();
    await expect(page).toHaveURL(/view=fleet/);
    await expect(page.locator('[data-preview-view="fleet"]')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/view=analyze/);
    await expect(page.locator('[data-analyze-workspace]')).toBeVisible();
    await expect(page.getByRole('heading', {
        name: 'Import distributed-run evidence'
    })).toBeVisible();
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
});

test('renders failure-first Monitor from canonical evidence', async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);

    const monitorSections = page.locator('[data-monitor-section]');
    await expect(monitorSections).toHaveCount(5);
    expect(await monitorSections.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-monitor-section'))))
        .toEqual([
            'verdict',
            'actions',
            'failures',
            'matrix',
            'timeline'
        ]);
    await expect(page.locator('[data-monitor-section="verdict"]'))
        .toHaveAttribute('data-run-state', 'failed');
    await expect(page.getByRole('heading', { name: 'Failures (1)' })).toBeVisible();
    const commandFailure = page.locator(
        `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`
    );
    await expect(commandFailure).toContainText(MONITOR_FAILURE_CODE);
    await expect(commandFailure).toContainText(MONITOR_FAILURE_MESSAGE);
    await expect(commandFailure).toHaveAttribute('aria-pressed', 'true');

    const matrix = page.getByRole('region', { name: 'Agent by phase matrix' });
    await expect(matrix.getByText(MONITOR_FAILURE_AGENT_ID, { exact: true })).toBeVisible();
    await expect(matrix.getByRole('columnheader', { name: 'ACK' })).toBeVisible();
    await expect(matrix.getByRole('columnheader', { name: 'Execution' })).toBeVisible();

    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.getByRole('heading', { name: 'Failure evidence' }))
        .toBeVisible();
    await expect(inspector.getByRole('heading', { name: 'Likely cause' })).toBeVisible();
    await expect(inspector).toContainText(MONITOR_FAILURE_MESSAGE);
    await expect(inspector.getByRole('heading', { name: 'Next action' })).toBeVisible();
    const minimalFix = inspector.locator('[data-minimal-fix]');
    await expect(minimalFix).toContainText(MONITOR_FAILURE_AGENT_ID);
    await expect(minimalFix).toContainText(MONITOR_FAILURE_COMMAND_ID);
    await expect(minimalFix).toContainText(MONITOR_FAILURE_RECIPE_ID);
    await expect(inspector.locator(
        `[data-evidence-destination="diagnostic"][data-evidence-id="${MONITOR_DIAGNOSTIC_ID}"]`
    )).toBeVisible();
    const legacyLink = inspector.getByRole('link', {
        name: 'Open this run in legacy Runs'
    });
    await expect(legacyLink).toBeVisible();
    const legacyUrl = new URL(await legacyLink.getAttribute('href') ?? '', page.url());
    expect(legacyUrl.searchParams.get('experience')).toBe('legacy');
    expect(legacyUrl.searchParams.get('workspace')).toBe('black-box-runner');
    expect(legacyUrl.searchParams.get('tab')).toBe('runs');
    expect(legacyUrl.searchParams.get('distributedRunId'))
        .toBe(MONITOR_DISTRIBUTED_RUN_ID);
});

test('opens one portrait failure inspector and restores focus', async ({ context, page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);

    const dock = page.locator('[data-selection-dock]');
    await expect(dock).toContainText(`Failure · ${MONITOR_FAILURE_AGENT_ID}`);
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
    const inspect = dock.getByRole('button', { name: 'Inspect' });
    await inspect.click();

    const sheet = page.getByRole('dialog', { name: 'Inspector' });
    await expect(sheet).toHaveCount(1);
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet).toHaveAttribute('data-mode', 'sheet');
    const close = sheet.getByRole('button', { name: 'Close inspector' });
    const legacyLink = sheet.getByRole('link', { name: 'Open this run in legacy Runs' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(legacyLink).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
    await expect(inspect).toBeFocused();

    const matrixScroller = page.locator('[data-monitor-matrix-scroller]');
    expect(await matrixScroller.evaluate((element) => element.scrollWidth > element.clientWidth))
        .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth))
        .toBe(true);
    await expect(page.locator('[data-monitor-section="timeline"] details[open]'))
        .toHaveCount(0);
});

test('traps and restores focus in tablet and landscape overlays', async ({ context, page }) => {
    await installRecipeConsoleMonitorFixture(context);
    for (const viewport of [{ width: 900, height: 900 }, { width: 932, height: 430 }]) {
        await page.setViewportSize(viewport);
        await page.goto(MONITOR_ROUTE);
        await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
        const inspect = page.locator(
            `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`
        );
        await inspect.click();

        const overlay = page.getByRole('dialog', { name: 'Inspector' });
        await expect(overlay).toHaveCount(1);
        await expect(overlay).toHaveAttribute('data-mode', 'overlay');
        const close = overlay.getByRole('button', { name: 'Close inspector' });
        const legacyLink = overlay.getByRole('link', { name: 'Open this run in legacy Runs' });
        await expect(close).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(legacyLink).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(close).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
        await expect(inspect).toBeFocused();
    }

    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(MONITOR_ROUTE);
    const routeTrigger = page.locator(
        `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`
    );
    await routeTrigger.click();
    await routeTrigger.evaluate((element) => {
        const state = window as Window & { __unrelatedRestoreCount?: number; };
        state.__unrelatedRestoreCount = 0;
        element.addEventListener('focus', () => {
            state.__unrelatedRestoreCount = (state.__unrelatedRestoreCount ?? 0) + 1;
        });
    });
    await page.evaluate(() => {
        history.pushState({}, '', '/?provider=simulated&experience=recipe-console&view=analyze');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'analyze');
    expect(
        await page.evaluate(() => (window as Window & { __unrelatedRestoreCount?: number; }).__unrelatedRestoreCount)
    )
        .toBe(0);

    await page.goto(MONITOR_ROUTE);
    const resizeTrigger = page.locator(
        `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`
    );
    await resizeTrigger.click();
    await resizeTrigger.evaluate((element) => {
        const state = window as Window & { __unrelatedResizeRestoreCount?: number; };
        state.__unrelatedResizeRestoreCount = 0;
        element.addEventListener('focus', () => {
            state.__unrelatedResizeRestoreCount = (state.__unrelatedResizeRestoreCount ?? 0) + 1;
        });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    expect(
        await page.evaluate(() =>
            (window as Window & { __unrelatedResizeRestoreCount?: number; })
                .__unrelatedResizeRestoreCount
        )
    ).toBe(0);
});

test('keeps the repository catalog and preflight usable with control offline', async ({ page }) => {
    const controlServerRequests: string[] = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        const controlPath = /^\/(?:runs|distributed-runs)(?:\/|$)/.test(url.pathname) ||
            url.pathname === '/control' ||
            url.pathname.startsWith('/control/') ||
            url.pathname.startsWith('/api/black-box/control');
        if (controlPath && ['fetch', 'xhr'].includes(request.resourceType())) {
            controlServerRequests.push(request.url());
        }
    });

    await routeOfflineControl(page);
    await page.goto(LIVE_EXECUTE_ROUTE);

    const search = page.getByRole('searchbox', { name: 'Search recipes' });
    const recipeLedger = page.getByRole('region', { name: 'Recipe ledger' });
    await expect(search).toBeVisible();
    await search.fill('pRoViDeR pArItY');
    await expect(recipeLedger.getByText('Provider Parity', { exact: true })).toBeVisible();
    await expect(recipeLedger.getByText('RTC Realtime Stability', { exact: true })).toHaveCount(0);
    await search.clear();
    const selectedRecipe = page.locator(
        '[data-execute-recipe][data-recipe-id="rtc-realtime-stability"]'
    );
    await expect(selectedRecipe).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Provider Parity', { exact: true })).toBeVisible();
    await expect(page.getByText('Composite Evidence', { exact: true })).toBeVisible();
    await expect(page.getByText('Expected Failure', { exact: true })).toBeVisible();
    await page.locator(
        '[data-execute-recipe][data-recipe-id="rallar-provider-parity-recipe"]'
    ).click();
    await expect(page).toHaveURL(/recipeId=rallar-provider-parity-recipe/);
    await expect(
        page.getByRole('complementary', { name: 'Inspector' })
            .getByRole('heading', { name: 'Provider Parity' })
    ).toBeVisible();
    await selectedRecipe.click();
    await expect(selectedRecipe).toHaveAttribute('aria-selected', 'true');

    const targets = page.getByRole('region', { name: 'Targets' });
    await expect(targets.getByText('No current target evidence', { exact: true }))
        .toBeVisible();
    const offlineTargetEvidence = targets.getByText(
        'Control is offline. Refresh to retry.',
        { exact: true }
    );
    await expect(offlineTargetEvidence).toHaveCount(2);
    await expect(offlineTargetEvidence.first()).toBeVisible();
    await expect(targets.locator('[data-execute-target]')).toHaveCount(0);
    await expect(targets.getByRole('checkbox')).toHaveCount(0);

    const preflight = page.getByRole('region', { name: 'Preflight' });
    await expect(preflight.getByText('Recipe ready', { exact: true })).toBeVisible();
    await expect(preflight.getByText('Manifest commands', { exact: true }).locator('..'))
        .toContainText('5');
    const agentSetup = page.locator('[data-execute-agent-setup]');
    await expect(agentSetup.getByRole('button', { name: 'Open 3 browser agents' }))
        .toBeDisabled();
    await expect(agentSetup.getByRole('alert')).toContainText(
        'A current control connection is required before launching browser agents.'
    );
    await expect(page.locator('[data-execute-manifest]')).toContainText('Unavailable');

    const actions = page.getByRole('region', { name: 'Execute next action' });
    await expect(actions.getByRole('button', { name: 'Refresh control data' }))
        .toBeEnabled();
    for (const action of ['Create draft', 'Export artifact', 'Cancel run']) {
        await expect(actions.getByRole('button', { name: action, exact: true }))
            .toHaveCount(0);
    }
    await expect(actions.getByRole('button', { name: /Resolve \d+ targets/ }))
        .toHaveCount(0);
    await expect(actions.getByRole('button', { name: 'Refresh', exact: true }))
        .toHaveCount(0);
    await expect(actions).toContainText('offline control truth');
    await expect(page.getByText(/Preview action|Stage Preview|Start Preview|Export Preview/))
        .toHaveCount(0);

    await expect(page.locator('[data-inspector-host]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'monitor');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Control evidence unavailable' }))
        .toBeVisible();
    await expect(page.locator('[data-selection-dock]')).toHaveCount(0);
    await expect.poll(() => controlServerRequests.length).toBeGreaterThan(0);
    expect(new URL(controlServerRequests[0]).pathname).toBe('/runs');

    await page.setViewportSize({ width: 430, height: 932 });
    await page.goto(LIVE_EXECUTE_ROUTE);
    expect((await page.getByRole('searchbox', { name: 'Search recipes' }).boundingBox())?.height)
        .toBeGreaterThanOrEqual(44);
    expect((await actions.getByRole('button', { name: 'Refresh control data', exact: true }).boundingBox())?.height)
        .toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('region', { name: 'Recipe ledger' }).getByRole('listbox'))
        .toHaveCSS('overflow-y', 'visible');
});

test('keeps selected recipe truth aligned across Execute surfaces', async ({ page }) => {
    await routeLiveExecuteControl(page);
    await page.goto(LIVE_EXECUTE_ROUTE);

    const providerRecipe = page.locator(
        '[data-execute-recipe][data-recipe-id="rallar-provider-parity-recipe"]'
    );
    await providerRecipe.click();
    await expect(providerRecipe).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/recipeId=rallar-provider-parity-recipe/);

    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.getByRole('heading', { name: 'Provider Parity' })).toBeVisible();
    await expect(inspector.getByText('Manifest commands', { exact: true }).locator('..'))
        .toContainText('10');

    const preflight = page.getByRole('region', { name: 'Preflight' });
    await expect(preflight.getByText('Manifest commands', { exact: true }).locator('..'))
        .toContainText('10');
    const preflightDetails = preflight.locator('details').filter({
        hasText: 'Preflight details'
    });
    await expect(preflightDetails.locator('summary')).toBeVisible();
    await expect(preflight.getByRole('heading', { name: 'Runtime surfaces' }))
        .not.toBeVisible();
    await preflightDetails.locator('summary').click();
    await expect(preflight.getByRole('heading', { name: 'Runtime surfaces' }))
        .toBeVisible();
    const manifest = page.locator('[data-execute-manifest]');
    await manifest.locator('summary').click();
    await expect(manifest)
        .toContainText('rallar-provider-parity-recipe');

    const targets = page.getByRole('region', { name: 'Targets' });
    await expect(targets.locator('[data-target-status="matched"]')).toHaveCount(2);
    await expect(targets.getByRole('checkbox')).toHaveCount(2);
    await expect(targets.getByText('2 selected', { exact: true })).toBeVisible();
    const actions = page.getByRole('region', { name: 'Execute next action' });
    await expect(actions.getByRole('button', { name: /Resolve \d+ targets/ })).toBeEnabled();
    await expect(actions.getByRole('button', { name: 'Create draft' })).toHaveCount(0);
    await expect(actions.getByRole('button', { name: /Stage \d+ agents/ })).toHaveCount(0);
    await expect(actions.getByRole('button', { name: 'Review and start' })).toHaveCount(0);
    await expect(
        page.locator('[data-command-bar]')
            .getByText('Safe targets', { exact: true }).locator('..')
    )
        .toContainText('2 selected · 2 recipe-safe');
});

test('refreshes Execute control truth without discarding the uncreated draft', async ({ page }) => {
    const controlServerRequests: string[] = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (
            ['fetch', 'xhr'].includes(request.resourceType()) &&
            (/^\/(?:runs|distributed-runs)(?:\/|$)/.test(url.pathname) ||
                url.pathname === '/control' ||
                url.pathname.startsWith('/control/') ||
                url.pathname.startsWith('/api/black-box/control'))
        ) {
            controlServerRequests.push(request.url());
        }
    });
    await routeLiveExecuteControl(page);
    await page.goto(LIVE_EXECUTE_ROUTE);
    await expect(page.locator('[data-command-bar] [data-status="passed"]'))
        .toContainText('Live · reachable');
    const targets = page.getByRole('region', { name: 'Targets' });
    const firstTarget = targets.getByRole('checkbox', { name: 'Select execute-agent-a' });
    await expect(firstTarget).toBeChecked();
    await firstTarget.uncheck();
    await expect(targets.getByText('1 selected', { exact: true })).toBeVisible();
    await page.locator('[data-execute-manifest] summary').click();
    const manifestJson = page.locator('[data-execute-manifest] pre code');
    await expect(manifestJson).toContainText('"distributedRunId"');
    const draftBeforeRefresh = await manifestJson.textContent();

    const requestsBeforeRefresh = controlServerRequests.length;
    await page.getByRole('button', { name: 'Refresh control data', exact: true }).click();

    await expect.poll(() => controlServerRequests.length)
        .toBeGreaterThan(requestsBeforeRefresh);
    await expect(manifestJson).toHaveText(draftBeforeRefresh ?? '');
    await expect(firstTarget).not.toBeChecked();
    await expect(targets.getByText('1 selected', { exact: true })).toBeVisible();
    await expect(page.locator(
        '[data-execute-recipe][data-recipe-id="rtc-realtime-stability"]'
    )).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => controlServerRequests.length)
        .toBeGreaterThan(requestsBeforeRefresh);
});

test('refreshes live Monitor truth without discarding selected evidence', async ({ context, page }) => {
    const fixture = await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);
    const commandFailure = page.locator(
        `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`
    );
    await commandFailure.click();
    await expect(commandFailure).toHaveAttribute('aria-pressed', 'true');
    const readsBeforeRefresh = fixture.runRequestCount();
    await page.getByRole('button', { name: 'Refresh control data', exact: true }).click();

    await expect.poll(fixture.runRequestCount).toBeGreaterThan(readsBeforeRefresh);
    await expect(commandFailure).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-failure-key]')).toHaveCount(1);
    await expect(
        page.getByRole('region', { name: 'Agent by phase matrix' })
            .getByText(MONITOR_FAILURE_AGENT_ID, { exact: true })
    ).toBeVisible();
});

test('requires known distributed-run truth before artifact export', async ({ page }) => {
    await routeLiveExecuteControl(page);
    await page.goto(LIVE_EXECUTE_ROUTE);
    let downloadCount = 0;
    page.on('download', () => downloadCount += 1);
    const actions = page.getByRole('region', { name: 'Execute next action' });
    await expect(actions.getByRole('button', { name: 'Export artifact' }))
        .toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export Preview' })).toHaveCount(0);
    expect(downloadCount).toBe(0);
});

test('blank URL opens Recipe Console Execute after the final ready-state flip', async ({ context, page }) => {
    const requestedResources: string[] = [];
    await context.addInitScript(() => {
        localStorage.setItem(
            'auth.session',
            JSON.stringify({
                clientId: 'ready-state-client',
                sessionId: 'ready-state-session',
                username: 'ready-state-operator',
                accessToken: 'ready-state-session-token',
                expiresAtEpochMs: 4_000_000_000_000
            })
        );
        localStorage.setItem(
            'rallar-black-box.ui.active-mode',
            'black-box-runner'
        );
        localStorage.setItem(
            'rallar-black-box.ui.active-tab',
            'event-stream'
        );
    });
    page.on('request', (request) => {
        if (
            request.resourceType() === 'script' ||
            request.resourceType() === 'stylesheet'
        ) {
            requestedResources.push(request.url());
        }
    });

    await page.goto('/');

    await expect(
        page.locator('.recipe-console[data-view="execute"]')
    ).toBeVisible();
    await expect(page.locator('[data-primary-navigation]'))
        .toHaveAttribute('aria-label', 'Recipe Console');
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await expect(page.locator('[id^="panel-"]')).toHaveCount(0);
    await expect.poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}${url.hash}`;
    }).toBe(
        '/?v=1&experience=recipe-console&view=execute' +
            '&recipeId=rtc-realtime-stability'
    );
    await expect(
        page.locator('[data-command-bar]')
            .getByText('Canonical', { exact: true })
    ).toBeVisible();
    await expect(page.locator('[data-url-issues]')).toHaveCount(0);
    expect(requestedResources.some((url) => url.includes('LegacyExperience')))
        .toBe(false);
});

test('keeps one lazy experience mounted', async ({ page }) => {
    await page.goto('/?provider=simulated&experience=legacy');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);

    await page.evaluate(() => {
        history.pushState({}, '', '/?provider=simulated&experience=recipe-console');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.recipe-console')).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);

    const legacyHref = '/?provider=simulated&tab=monitor&futureField=keep#trace=legacy';
    await page.evaluate((href) => {
        history.pushState({}, '', href);
        dispatchEvent(new PopStateEvent('popstate'));
    }, legacyHref);
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);
    await expect.poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}${url.hash}`;
    }).toBe(legacyHref);
});

test('keeps auth summary typography before either experience loads', async ({ page }) => {
    const requestedScripts: string[] = [];
    page.on('request', (request) => {
        if (request.resourceType() === 'script') {
            requestedScripts.push(request.url());
        }
    });

    await page.goto(
        '/?provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.invalid'
    );
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
        .toBeVisible();
    expect(requestedScripts.some((url) => url.includes('LegacyExperience')))
        .toBe(false);
    expect(requestedScripts.some((url) => url.includes('RecipeConsoleApp')))
        .toBe(false);

    const termStyle = await page.locator('.auth-summary dt').first().evaluate(
        (element) => {
            const style = getComputedStyle(element);
            return { color: style.color, fontSize: style.fontSize };
        }
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
                whiteSpace: style.whiteSpace
            };
        });

    expect(termStyle).toEqual({
        color: 'rgb(103, 118, 111)',
        fontSize: '11.52px'
    });
    expect(descriptionStyle).toEqual({
        minWidth: '0px',
        margin: '2px 0px 0px',
        overflow: 'hidden',
        color: 'rgb(29, 40, 35)',
        fontWeight: '700',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
    });
});
