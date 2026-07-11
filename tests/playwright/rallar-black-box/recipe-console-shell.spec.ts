import { expect, test } from '@playwright/test';

test('renders command-duration Tune without invented stream evidence', async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 });
    await page.goto('/?provider=simulated&experience=recipe-console&view=tune');

    await expect(page.locator('[data-command-bar]')).toHaveCSS('height', '48px');
    expect((await page.locator('[data-primary-navigation]').boundingBox())?.width).toBe(60);
    const commandBar = page.locator('[data-command-bar]');
    await expect(commandBar).toContainText('Tune · RTC timing');
    await expect(commandBar).toContainText('seed-high-latency-rtc');
    await expect(commandBar).toContainText('Passed');
    await expect(commandBar).not.toContainText('Baseline');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    const matrixPane = page.locator('[data-landscape-matrix]');
    const timingPane = page.locator('[data-landscape-timing]');
    const matrixBox = await matrixPane.boundingBox();
    const timingBox = await timingPane.boundingBox();
    expect((matrixBox?.width ?? 0) / ((matrixBox?.width ?? 0) + (timingBox?.width ?? 0)))
        .toBeCloseTo(0.52, 1);
    await expect(matrixPane.locator('[data-tune-agent]')).toHaveCount(3);
    const timingGrid = matrixPane.getByRole('grid', { name: 'Tune agent timing matrix' });
    await expect(timingGrid.getByRole('row')).toHaveCount(4);
    for (const agentId of ['seed-agent-a', 'seed-agent-b', 'seed-agent-c']) {
        const agentRow = timingGrid.getByRole('row').filter({
            has: page.locator(`[data-tune-agent="${agentId}"]`),
        });
        await expect(agentRow).toHaveCount(1);
        await expect(agentRow.getByRole('gridcell')).toHaveCount(8);
    }
    await expect(matrixPane.getByText('seed-agent-a', { exact: true })).toBeVisible();
    await expect(matrixPane.getByText('seed-agent-b', { exact: true })).toBeVisible();
    await expect(matrixPane.getByText('seed-agent-c', { exact: true })).toBeVisible();

    for (const [label, value] of [
        ['P50', '1,010 ms'],
        ['P95', '1,190 ms'],
        ['P99', '1,190 ms'],
        ['Max', '1,190 ms'],
    ] as const) {
        const metric = timingPane.locator('dl > div').filter({ hasText: label });
        await expect(metric).toContainText(value);
    }
    const distribution = timingPane.getByRole('img', { name: 'Command duration distribution' });
    await expect(distribution).toBeVisible();
    await expect(distribution.locator('[data-histogram-bar]')).toHaveCount(4);
    await expect(distribution.locator('[data-duration-point]')).toHaveCount(3);
    await expect(distribution).toContainText('Duration (ms)');
    const distributionBounds = await distribution.boundingBox();
    expect(distributionBounds).not.toBeNull();
    for (const label of await distribution.locator('[data-duration-point] text').all()) {
        const labelBounds = await label.boundingBox();
        expect(labelBounds).not.toBeNull();
        expect((labelBounds?.x ?? 0) + (labelBounds?.width ?? 0))
            .toBeLessThanOrEqual((distributionBounds?.x ?? 0) + (distributionBounds?.width ?? 0) + 1);
    }

    const agentA = matrixPane.getByRole('gridcell', { name: /seed-agent-a/ });
    const agentB = matrixPane.getByRole('gridcell', { name: /seed-agent-b/ });
    const agentC = matrixPane.getByRole('gridcell', { name: /seed-agent-c/ });
    await agentA.focus();
    await page.keyboard.press('ArrowDown');
    await expect(agentB).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(agentC).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-selected-agent]')).toHaveText('seed-agent-c');
    await page.keyboard.press('Escape');
    await expect(agentC).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(agentB).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-selected-agent]')).toHaveText('seed-agent-b');
    await page.keyboard.press('Escape');
    await expect(agentB).toBeFocused();

    for (const [metric, value] of [
        ['Send duration', 'stream-send-duration'],
        ['Drift', 'stream-drift'],
        ['Cadence', 'stream-cadence'],
    ] as const) {
        await timingPane.getByRole('button', { name: metric, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`timingMetric=${value}`));
        const unavailable = timingPane.locator('[data-timing-unavailable]');
        await expect(unavailable).toContainText('Unavailable in this command-duration seed');
        await expect(unavailable).toContainText('RTC timeline evidence is not available.');
        expect(await unavailable.textContent()).not.toMatch(/\b0(?:\.0+)?\s*(?:ms|frames|%)\b/);
    }
    expect(await page.evaluate(() => ({
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }))).toEqual({ x: 0, y: 0 });
});

test('routes bounded Analyze Fleet and Advanced previews', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/?provider=simulated&experience=recipe-console&view=analyze');
    const initialHistoryLength = await page.evaluate(() => history.length);

    const analyze = page.locator('[data-preview-view="analyze"]');
    await expect(analyze.getByRole('heading', { name: 'Seeded artifact readiness' })).toBeVisible();
    await expect(analyze.getByText('Core bundle', { exact: true })).toBeVisible();
    await expect(analyze.getByText('Evidence bundle', { exact: true })).toBeVisible();
    await expect(analyze.getByText('Partial bundle', { exact: true })).toBeVisible();
    const coreBundle = analyze.locator('li').filter({ hasText: 'Core bundle' });
    await expect(coreBundle).toContainText('distributed-run.json, manifest.json, and control-run.json');
    await expect(coreBundle).not.toContainText('report.json');
    const evidenceBundle = analyze.locator('li').filter({ hasText: 'Evidence bundle' });
    await expect(evidenceBundle).toContainText('report.json');
    await expect(evidenceBundle).toContainText('results.jsonl');
    await expect(analyze.locator('input[type="file"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Fleet', exact: true }).click();
    await expect(page).toHaveURL(/view=fleet/);
    await expect(page.locator('[data-preview-view="fleet"]')
        .getByText('Fleet live data unavailable in offline preview', { exact: true }))
        .toBeVisible();
    await expect(page.getByText('No control connection is available in offline preview.', { exact: true }))
        .toBeVisible();
    await expect(page.locator('[data-preview-view="fleet"] [data-fleet-region]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(page).toHaveURL(/view=advanced/);
    const advanced = page.locator('[data-preview-view="advanced"]');
    await expect(advanced.getByRole('heading', { name: 'Legacy compatibility bridge' }))
        .toBeVisible();
    for (const [label, tab] of [
        ['Auth', 'auth'],
        ['Groups', 'rooms-clients'],
        ['WebSocket', 'websocket'],
        ['RTC', 'rtc-diagnostics'],
        ['Data', 'rallar-data'],
        ['CRDT', 'crdt-health'],
        ['Media', 'media'],
        ['Server', 'rallar-server'],
        ['Tracing', 'rallar-trace'],
    ] as const) {
        await expect(advanced.getByRole('link', { name: label, exact: true }))
            .toHaveAttribute(
                'href',
                `/?provider=simulated&experience=legacy&tab=${tab}`,
            );
    }
    await expect(page.locator('.app-shell')).toHaveCount(0);
    expect(await page.evaluate(() => history.length)).toBeGreaterThanOrEqual(initialHistoryLength + 2);

    await page.goBack();
    await expect(page).toHaveURL(/view=fleet/);
    await expect(page.locator('[data-preview-view="fleet"]')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/view=analyze/);
    await expect(page.locator('[data-preview-view="analyze"]')).toBeVisible();
});

test('renders failure-first Monitor from canonical evidence', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?provider=simulated&experience=recipe-console&view=monitor');

    const monitorSections = page.locator('[data-monitor-section]');
    await expect(monitorSections).toHaveCount(5);
    expect(await monitorSections.evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('data-monitor-section'))
    )).toEqual([
        'verdict',
        'actions',
        'failures',
        'matrix',
        'timeline',
    ]);
    await expect(page.getByText('Outcome failed', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Failures (2)' })).toBeVisible();
    const recipeFailure = page.locator('[data-failure-key="seed-rtc-recipe"]');
    const commandFailure = page.locator('[data-failure-key="seed-start-receiver"]');
    await expect(recipeFailure).toContainText('SYNTHETIC_RECIPE_FAILED');
    await expect(recipeFailure).toContainText('Receiver did not observe the RTC payload.');
    await expect(commandFailure).toContainText('SYNTHETIC_ASSERTION_FAILED');
    await expect(commandFailure).toContainText('Receiver did not observe the RTC payload.');
    await expect(commandFailure.getByRole('option')).toHaveAttribute('aria-selected', 'true');

    const matrix = page.getByRole('region', { name: 'Agent by phase matrix' });
    await expect(matrix.getByText('seed-agent-a', { exact: true })).toBeVisible();
    await expect(matrix.getByText('seed-agent-b', { exact: true })).toBeVisible();
    await expect(matrix.getByRole('columnheader', { name: 'Stage' })).toBeVisible();
    await expect(matrix.getByRole('columnheader', { name: 'Start' })).toBeVisible();

    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.getByRole('heading', { name: 'Failure · seed-agent-b' }))
        .toBeVisible();
    await expect(inspector.getByRole('heading', { name: 'Likely cause' })).toBeVisible();
    await expect(inspector.getByText('Receiver did not observe the RTC payload.', { exact: true }))
        .toBeVisible();
    await expect(inspector.getByRole('heading', { name: 'Next action' })).toBeVisible();
    await expect(inspector.getByText(
        'Open command seed-start-receiver on agent seed-agent-b, inspect the command payload/result, and compare sibling agents running the same recipe.',
        { exact: true },
    )).toBeVisible();
    await expect(inspector.getByRole('heading', { name: 'Minimal fix area' })).toBeVisible();
    const minimalFix = inspector.locator('[data-minimal-fix]');
    await expect(minimalFix.getByText('seed-agent-b', { exact: true })).toBeVisible();
    await expect(minimalFix.getByText('seed-start-receiver', { exact: true })).toBeVisible();
    await expect(minimalFix.getByText('seed-rtc-recipe', { exact: true })).toBeVisible();
    await expect(inspector.getByRole('heading', { name: 'Correlated evidence' })).toBeVisible();
    await expect(inspector.locator('[data-causal-kind]')).toHaveCount(5);
    await expect(inspector.locator('[data-causal-kind="diagnostic"]'))
        .toContainText('seed-start-receiver-error-diagnostic');
    await expect(inspector.getByRole('link', { name: 'Open legacy RTC diagnostic' }))
        .toHaveAttribute('href', '/?provider=simulated&experience=legacy&tab=rtc-diagnostics');

    const stale = page.getByRole('button', { name: 'Simulate stale connection' });
    await stale.click();
    await expect(page.getByText('Stale · reconnecting', { exact: true })).toBeVisible();
    await expect(page.getByText('Last known evidence 12s ago', { exact: true })).toBeVisible();
    await expect(page.locator('[data-failure-key]')).toHaveCount(2);
    await expect(matrix.getByText('seed-agent-b', { exact: true })).toBeVisible();
});

test('opens one portrait failure inspector and restores focus', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await page.goto('/?provider=simulated&experience=recipe-console&view=monitor');

    const dock = page.locator('[data-selection-dock]');
    await expect(dock).toContainText('Failure · seed-agent-b');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
    const inspect = dock.getByRole('button', { name: 'Inspect' });
    await inspect.click();

    const sheet = page.getByRole('dialog', { name: 'Inspector' });
    await expect(sheet).toHaveCount(1);
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet).toHaveAttribute('data-mode', 'sheet');
    const close = sheet.getByRole('button', { name: 'Close inspector' });
    const legacyLink = sheet.getByRole('link', { name: 'Open legacy RTC diagnostic' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(legacyLink).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
    await expect(inspect).toBeFocused();

    const matrixScroller = page.locator('[data-monitor-matrix-scroller]');
    expect(await matrixScroller.evaluate(element => element.scrollWidth > element.clientWidth))
        .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth))
        .toBe(true);
    await expect(page.locator('[data-monitor-section="timeline"] details')).not.toHaveAttribute('open', '');
});

test('traps and restores focus in tablet and landscape overlays', async ({ page }) => {
    for (const viewport of [{ width: 900, height: 900 }, { width: 932, height: 430 }]) {
        await page.setViewportSize(viewport);
        await page.goto('/?provider=simulated&experience=recipe-console&view=monitor');
        await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
        const inspect = page.getByRole('button', { name: 'Inspect failure' });
        await inspect.click();

        const overlay = page.getByRole('dialog', { name: 'Inspector' });
        await expect(overlay).toHaveCount(1);
        await expect(overlay).toHaveAttribute('data-mode', 'overlay');
        const close = overlay.getByRole('button', { name: 'Close inspector' });
        const legacyLink = overlay.getByRole('link', { name: 'Open legacy RTC diagnostic' });
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
    await page.goto('/?provider=simulated&experience=recipe-console&view=monitor');
    const routeTrigger = page.getByRole('button', { name: 'Inspect failure' });
    await routeTrigger.click();
    await routeTrigger.evaluate(element => {
        const state = window as Window & { __unrelatedRestoreCount?: number };
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
    expect(await page.evaluate(() =>
        (window as Window & { __unrelatedRestoreCount?: number }).__unrelatedRestoreCount
    )).toBe(0);

    await page.goto('/?provider=simulated&experience=recipe-console&view=monitor');
    const resizeTrigger = page.getByRole('button', { name: 'Inspect failure' });
    await resizeTrigger.click();
    await resizeTrigger.evaluate(element => {
        const state = window as Window & { __unrelatedResizeRestoreCount?: number };
        state.__unrelatedResizeRestoreCount = 0;
        element.addEventListener('focus', () => {
            state.__unrelatedResizeRestoreCount =
                (state.__unrelatedResizeRestoreCount ?? 0) + 1;
        });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    expect(await page.evaluate(() =>
        (window as Window & { __unrelatedResizeRestoreCount?: number })
            .__unrelatedResizeRestoreCount
    )).toBe(0);
});

test('renders repository-backed Execute preview without services', async ({ page }) => {
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

    await page.goto('/?provider=simulated&experience=recipe-console&view=execute');

    const search = page.getByRole('searchbox', { name: 'Search recipes' });
    const recipeLedger = page.getByRole('region', { name: 'Recipes' });
    await expect(search).toBeVisible();
    await search.fill('pRoViDeR pArItY');
    await expect(recipeLedger.getByText('Provider Parity', { exact: true })).toBeVisible();
    await expect(recipeLedger.getByText('RTC Realtime Stability', { exact: true })).toHaveCount(0);
    await search.clear();
    const selectedRecipe = page.getByRole('button', { name: /RTC Realtime Stability/ });
    await expect(selectedRecipe).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Provider Parity', { exact: true })).toBeVisible();
    await expect(page.getByText('Composite Evidence', { exact: true })).toBeVisible();
    await expect(page.getByText('Expected Failure', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Provider Parity/ }).click();
    await expect(page.getByRole('complementary', { name: 'Inspector' })
        .getByRole('heading', { name: 'Provider Parity' })).toBeVisible();
    await selectedRecipe.click();
    await expect(selectedRecipe).toHaveAttribute('aria-selected', 'true');

    const targets = page.getByRole('region', { name: 'Sample targets and preflight' });
    await expect(targets.getByText('2/2 selected', { exact: true })).toBeVisible();
    await expect(targets.getByText('seed-agent-a', { exact: true })).toBeVisible();
    await expect(targets.getByText('seed-agent-b', { exact: true })).toBeVisible();
    const firstTarget = targets.getByRole('checkbox', { name: 'Select seed-agent-a' });
    await firstTarget.uncheck();
    await expect(targets.getByText('1/2 selected', { exact: true })).toBeVisible();
    await firstTarget.check();
    await expect(targets.getByText('2/2 selected', { exact: true })).toBeVisible();
    await expect(targets.getByText('Required · not checked in preview', { exact: true }))
        .toBeVisible();

    await expect(page.getByText('5 manifest commands - 25 stream frames', { exact: true }))
        .toBeVisible();
    const preflight = targets.locator('details');
    await expect(preflight).toHaveAttribute('open', '');
    await preflight.locator('summary').click();
    await expect(preflight).not.toHaveAttribute('open', '');
    await preflight.locator('summary').click();
    await expect(preflight).toHaveAttribute('open', '');
    await expect(page.getByText('Preview only', { exact: true })).toBeVisible();
    const cancel = page.getByRole('button', { name: 'Cancel Preview' });
    await expect(cancel).toBeDisabled();
    await expect(page.getByText('Nothing to cancel until live execution is available.', { exact: true }))
        .toBeVisible();
    const start = page.getByRole('button', { name: 'Start Preview', exact: true });
    await expect(start).toHaveCount(1);
    await expect(start).toHaveAttribute('data-primary-action', 'true');
    await expect(page.getByText('Live execution begins in Iteration 4.', { exact: true }))
        .toBeVisible();

    await expect(page.locator('[data-preview-status]')).toHaveText('Idle preview');
    await page.getByRole('button', { name: 'Stage Preview', exact: true }).click();
    await expect(page.locator('[data-preview-status]')).toHaveText('Staged preview');
    await start.click();
    await expect(page.locator('[data-preview-status]')).toHaveText('Started preview');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'monitor');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(1);
    await expect(page.locator('[data-inspector-host]')
        .getByRole('heading', { name: 'Failure · seed-agent-b' })).toBeVisible();
    await expect(page.locator('[data-inspector-host]')
        .getByText('RTC Realtime Stability', { exact: true })).toHaveCount(0);
    expect(controlServerRequests).toEqual([]);

    await page.setViewportSize({ width: 430, height: 932 });
    await page.goto('/?provider=simulated&experience=recipe-console&view=execute');
    expect((await page.getByRole('searchbox', { name: 'Search recipes' }).boundingBox())?.height)
        .toBeGreaterThanOrEqual(44);
    expect((await page.getByRole('button', { name: 'Start Preview' }).boundingBox())?.height)
        .toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('region', { name: 'Recipes' })).toHaveCSS('overflow-y', 'visible');
});

test('keeps one lazy experience mounted', async ({ page }) => {
    await page.goto('/?provider=simulated');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);

    await page.evaluate(() => {
        history.pushState({}, '', '/?provider=simulated&experience=recipe-console');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.recipe-console')).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);

    await page.evaluate(() => {
        history.pushState({}, '', '/?provider=simulated&tab=monitor');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);
});

test('keeps auth summary typography before either experience loads', async ({ page }) => {
    const requestedScripts: string[] = [];
    page.on('request', (request) => {
        if (request.resourceType() === 'script') {
            requestedScripts.push(request.url());
        }
    });

    await page.goto(
        '/?provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.invalid',
    );
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
        .toBeVisible();
    expect(requestedScripts.some(url => url.includes('LegacyExperience')))
        .toBe(false);
    expect(requestedScripts.some(url => url.includes('RecipeConsoleApp')))
        .toBe(false);

    const termStyle = await page.locator('.auth-summary dt').first().evaluate(
        (element) => {
            const style = getComputedStyle(element);
            return { color: style.color, fontSize: style.fontSize };
        },
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
                whiteSpace: style.whiteSpace,
            };
        });

    expect(termStyle).toEqual({
        color: 'rgb(103, 118, 111)',
        fontSize: '11.52px',
    });
    expect(descriptionStyle).toEqual({
        minWidth: '0px',
        margin: '2px 0px 0px',
        overflow: 'hidden',
        color: 'rgb(29, 40, 35)',
        fontWeight: '700',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    });
});
