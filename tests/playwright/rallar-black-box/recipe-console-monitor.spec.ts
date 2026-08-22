import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
    installRecipeConsoleMonitorFixture,
    MONITOR_CONTROL_RUN_ID,
    MONITOR_DIAGNOSTIC_ID,
    MONITOR_DISTRIBUTED_RUN_ID,
    MONITOR_EVENT_ID,
    MONITOR_FAILURE_AGENT_ID,
    MONITOR_FAILURE_CODE,
    MONITOR_FAILURE_COMMAND_ID,
    MONITOR_FAILURE_MESSAGE,
    MONITOR_FAILURE_RECIPE_ID,
    MONITOR_ROUTE
} from './recipe-console-monitor-fixture.ts';

const EXPECTED_SECTION_ORDER = [
    'verdict',
    'actions',
    'failures',
    'matrix',
    'timeline'
] as const;

function monitorInspector(page: Page): Locator {
    return page.locator('[data-monitor-inspector]');
}

function failureRow(page: Page): Locator {
    return page.locator(`[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`);
}

async function selectFailure(page: Page): Promise<Locator> {
    const row = failureRow(page);
    await row.click();
    const inspector = monitorInspector(page);
    await expect(inspector).toHaveAttribute('data-selection-kind', 'failure');
    await expect(inspector).toContainText(MONITOR_FAILURE_COMMAND_ID);
    return inspector;
}

function currentUrl(page: Page): URL {
    return new URL(page.url());
}

async function installAbortIgnoringArtifactGate(
    context: BrowserContext
): Promise<void> {
    await context.addInitScript((pathname) => {
        const originalFetch = window.fetch.bind(window);
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const state = { pathname, started: false, release };
        Object.defineProperty(window, '__monitorArtifactFetchGate', {
            configurable: true,
            value: state
        });
        window.fetch = async (input, init) => {
            const url = new URL(
                typeof input === 'string' ? input : input instanceof URL
                    ? input.href
                    : input.url,
                location.href
            );
            if (url.pathname !== state.pathname) {
                return originalFetch(input, init);
            }
            state.started = true;
            await gate;
            const withoutSignal = init ? { ...init, signal: undefined } : init;
            return originalFetch(input, withoutSignal);
        };
    }, `/distributed-runs/${MONITOR_DISTRIBUTED_RUN_ID}/artifacts`);
}

async function waitForAbortIgnoringArtifact(page: Page): Promise<void> {
    await page.waitForFunction(() =>
        Boolean(
            (window as unknown as {
                __monitorArtifactFetchGate?: { started: boolean; };
            }).__monitorArtifactFetchGate?.started
        )
    );
}

async function releaseAbortIgnoringArtifact(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as unknown as {
            __monitorArtifactFetchGate?: { release(): void; };
        }).__monitorArtifactFetchGate?.release();
    });
}

async function refreshMonitor(page: Page, requestCount: () => number): Promise<void> {
    const readsBeforeRefresh = requestCount();
    await page.getByRole('region', { name: 'Monitor actions' })
        .getByRole('button', { name: 'Refresh' })
        .click();
    await expect.poll(requestCount).toBeGreaterThan(readsBeforeRefresh);
}

type EvidenceDestination = Readonly<{
    kind: 'agent' | 'recipe' | 'command' | 'diagnostic' | 'timeline' | 'event' | 'artifact';
    id: string;
}>;

function expectedDestinationUrl(destination: EvidenceDestination) {
    if (destination.kind === 'agent') {
        return { agentId: MONITOR_FAILURE_AGENT_ID, recipeId: null, commandId: null };
    }
    if (destination.kind === 'recipe') {
        return { agentId: null, recipeId: MONITOR_FAILURE_RECIPE_ID, commandId: null };
    }
    if (destination.kind === 'artifact') {
        return { agentId: null, recipeId: null, commandId: null };
    }
    const hasRecipe = destination.kind === 'command' || (
        destination.kind === 'timeline' &&
        /^(?:queued|dispatched|completed|failure)-/.test(destination.id)
    );
    return {
        agentId: MONITOR_FAILURE_AGENT_ID,
        recipeId: hasRecipe ? MONITOR_FAILURE_RECIPE_ID : null,
        commandId: MONITOR_FAILURE_COMMAND_ID
    };
}

test('places the failure verdict and failure list before raw event evidence', async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installRecipeConsoleMonitorFixture(context);

    await page.goto(MONITOR_ROUTE);
    await expect.poll(fixture.runRequestCount).toBeGreaterThan(0);
    await expect.poll(fixture.distributedRunRequestCount).toBeGreaterThan(0);

    const sections = page.locator('[data-monitor-section]');
    await expect(sections).toHaveCount(EXPECTED_SECTION_ORDER.length);
    expect(await sections.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-monitor-section'))))
        .toEqual(EXPECTED_SECTION_ORDER);

    const verdict = page.locator('[data-monitor-section="verdict"]');
    const failures = page.locator('[data-monitor-section="failures"]');
    const matrix = page.locator('[data-monitor-section="matrix"]');
    const rawEvidence = page.locator('[data-monitor-section="timeline"]');
    await expect(verdict).toHaveAttribute('data-run-state', 'failed');
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(verdict).toHaveAttribute('data-evidence-completeness', 'complete');
    await expect(verdict.locator('[data-status="failed"]')).toContainText('Failed');
    await expect(verdict).toContainText(MONITOR_FAILURE_AGENT_ID);
    await expect(verdict).toContainText(
        `Open command ${MONITOR_FAILURE_COMMAND_ID} on ${MONITOR_FAILURE_AGENT_ID}.`
    );
    await expect(page.locator('[data-failure-key]')).toHaveCount(1);
    await expect(failureRow(page)).toContainText(MONITOR_FAILURE_CODE);
    await expect(failureRow(page)).toContainText(MONITOR_FAILURE_MESSAGE);
    await expect(matrix).toContainText(MONITOR_FAILURE_AGENT_ID);
    await expect(rawEvidence.locator('details[open]')).toHaveCount(0);

    const verticalOrder = await Promise.all(
        [verdict, failures, matrix, rawEvidence].map(async (section) =>
            (await section.boundingBox())?.y ?? Number.POSITIVE_INFINITY
        )
    );
    expect(verticalOrder).toEqual([...verticalOrder].sort((left, right) => left - right));

    const inspector = await selectFailure(page);
    await expect(inspector.getByRole('heading', { name: 'Distributed command failed' }))
        .toBeVisible();
    await expect(inspector.getByRole('heading', { name: 'Likely cause' }))
        .toBeVisible();
    await expect(inspector.getByRole('heading', { name: 'Next action' }))
        .toBeVisible();
    await expect(inspector).toContainText(MONITOR_FAILURE_MESSAGE);
    await expect(inspector).toContainText(
        'Open the composite drilldown and runtime diagnostics for the failing agent, then compare expected vs observed payload evidence.'
    );
});

test('opens all available correlated evidence from a failure row', async ({ baseURL, context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: new URL(baseURL ?? 'http://127.0.0.1:5176').origin }
    );
    const fixture = await installRecipeConsoleMonitorFixture(context);

    await page.goto(MONITOR_ROUTE);
    const actions = page.getByRole('region', { name: 'Monitor actions' });
    await actions.getByRole('button', { name: 'Load artifact' }).click();
    await expect.poll(fixture.artifactRequestCount).toBe(1);
    await expect(actions).toContainText('artifact valid');
    const downloadPromise = page.waitForEvent('download');
    await actions.getByRole('button', { name: 'Export artifact' }).click();
    const download = await downloadPromise;
    await expect.poll(fixture.artifactRequestCount).toBe(2);
    expect(download.suggestedFilename()).toBe(
        `${MONITOR_DISTRIBUTED_RUN_ID}-artifact.json`
    );
    const downloadPath = await download.path();
    if (!downloadPath) {
        throw new Error('Monitor artifact download path is unavailable.');
    }
    expect(JSON.parse(await readFile(downloadPath, 'utf8'))).toMatchObject({
        artifactSchemaVersion: 2,
        distributedRunId: MONITOR_DISTRIBUTED_RUN_ID,
        generatedAtEpochMs: expect.any(Number),
        files: {
            'distributed-run.json': expect.any(String),
            'manifest.json': expect.any(String),
            'control-run.json': expect.any(String)
        }
    });

    const failureInspector = await selectFailure(page);
    const destinations = await failureInspector
        .locator('[data-evidence-destination][data-evidence-id]')
        .evaluateAll((buttons) =>
            buttons.map((button) => ({
                kind: button.getAttribute('data-evidence-destination'),
                id: button.getAttribute('data-evidence-id')
            }))
        ) as EvidenceDestination[];
    expect([...new Set(destinations.map((destination) => destination.kind))])
        .toEqual(['agent', 'recipe', 'command', 'diagnostic', 'timeline', 'event', 'artifact']);
    expect(destinations.length).toBeGreaterThan(7);

    for (const destination of destinations) {
        const inspector = await selectFailure(page);
        const button = inspector.locator(
            `[data-evidence-destination="${destination.kind}"]` +
                `[data-evidence-id="${destination.id}"]`
        );
        await expect(button, `${destination.kind}:${destination.id}`).toHaveCount(1);
        await button.click();
        await expect(monitorInspector(page)).toHaveAttribute(
            'data-selection-kind',
            destination.kind
        );
        await expect(monitorInspector(page).locator('header code'))
            .toHaveText(destination.id);
        const expected = expectedDestinationUrl(destination);
        const url = currentUrl(page);
        expect(url.searchParams.get('agentId'), `${destination.kind}:${destination.id} agentId`)
            .toBe(expected.agentId);
        expect(url.searchParams.get('recipeId'), `${destination.kind}:${destination.id} recipeId`)
            .toBe(expected.recipeId);
        expect(url.searchParams.get('commandId'), `${destination.kind}:${destination.id} commandId`)
            .toBe(expected.commandId);
    }

    await selectFailure(page);
    await monitorInspector(page)
        .locator(`[data-evidence-destination="diagnostic"][data-evidence-id="${MONITOR_DIAGNOSTIC_ID}"]`)
        .click();
    const diagnostics = page.locator('[data-monitor-diagnostics]');
    await diagnostics.getByLabel('Severity').selectOption('error');
    await diagnostics.getByLabel('Transport').selectOption('messages.rtc');
    await expect(monitorInspector(page)).toHaveAttribute(
        'data-selection-kind',
        'diagnostic'
    );
    await expect(monitorInspector(page)).toContainText(MONITOR_DIAGNOSTIC_ID);
    expect(currentUrl(page).searchParams.get('diagnosticSeverity')).toBe('error');
    expect(currentUrl(page).searchParams.get('transport')).toBe('messages.rtc');

    await selectFailure(page);
    await monitorInspector(page)
        .locator(`[data-evidence-destination="event"][data-evidence-id="${MONITOR_EVENT_ID}"]`)
        .click();
    await expect(monitorInspector(page)).toHaveAttribute('data-selection-kind', 'event');
    await expect(monitorInspector(page)).toContainText(MONITOR_EVENT_ID);

    await selectFailure(page);
    await monitorInspector(page)
        .locator(`[data-evidence-destination="command"][data-evidence-id="${MONITOR_FAILURE_COMMAND_ID}"]`)
        .click();
    await expect(monitorInspector(page)).toHaveAttribute('data-selection-kind', 'command');
    await page.getByRole('button', { name: 'Copy canonical link' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain(`commandId=${MONITOR_FAILURE_COMMAND_ID}`);
    const copiedHref = await page.evaluate(() => navigator.clipboard.readText());
    const copied = new URL(copiedHref);
    expect(copied.searchParams.get('controlRunId')).toBe(MONITOR_CONTROL_RUN_ID);
    expect(copied.searchParams.get('distributedRunId')).toBe(MONITOR_DISTRIBUTED_RUN_ID);
    expect(copied.searchParams.get('agentId')).toBe(MONITOR_FAILURE_AGENT_ID);
    expect(copied.searchParams.get('recipeId')).toBe(MONITOR_FAILURE_RECIPE_ID);
    expect(copied.searchParams.get('commandId')).toBe(MONITOR_FAILURE_COMMAND_ID);

    await selectFailure(page);
    await monitorInspector(page)
        .locator(`[data-evidence-destination="agent"][data-evidence-id="${MONITOR_FAILURE_AGENT_ID}"]`)
        .click();
    await expect(monitorInspector(page)).toHaveAttribute('data-selection-kind', 'agent');
    await page.goBack();
    await expect(monitorInspector(page)).toHaveAttribute('data-selection-kind', 'command');
    await page.reload();
    await expect(monitorInspector(page)).toHaveAttribute('data-selection-kind', 'command');
    await expect(monitorInspector(page)).toContainText(MONITOR_FAILURE_COMMAND_ID);

    await page.goto(copiedHref);
    await expect(monitorInspector(page)).toHaveAttribute('data-selection-kind', 'command');
    await expect(monitorInspector(page)).toContainText(MONITOR_FAILURE_COMMAND_ID);
});

test('preserves last-known evidence while a selected run refresh fails', async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installRecipeConsoleMonitorFixture(context);

    await page.goto(MONITOR_ROUTE);
    const verdict = page.locator('[data-monitor-section="verdict"]');
    const matrix = page.locator('[data-monitor-section="matrix"]');
    const failure = failureRow(page);
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(failure).toContainText(MONITOR_FAILURE_MESSAGE);
    await expect(matrix).toContainText(MONITOR_FAILURE_AGENT_ID);

    fixture.failNextRunRead();
    const readsBeforeFailure = fixture.runRequestCount();
    const actions = page.getByRole('region', { name: 'Monitor actions' });
    await actions.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(fixture.runRequestCount).toBeGreaterThan(readsBeforeFailure);

    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'last-known');
    await expect(verdict).toHaveAttribute('data-evidence-completeness', 'complete');
    await expect(verdict).toContainText('Last-known evidence — remote actions blocked');
    await expect(page.locator('[data-monitor-run-selector]'))
        .toContainText('Last-known truth');
    await expect(failure).toContainText(MONITOR_FAILURE_MESSAGE);
    await expect(matrix).toContainText(MONITOR_FAILURE_AGENT_ID);
    await expect(actions.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await expect(actions.getByRole('button', { name: 'Load artifact' })).toBeDisabled();
    await expect(actions.getByRole('button', { name: 'Export artifact' })).toBeDisabled();
    await expect(actions.getByRole('button', { name: 'Cancel run' })).toBeDisabled();

    fixture.recoverRunReads();
    const readsBeforeRecovery = fixture.runRequestCount();
    await actions.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(fixture.runRequestCount).toBeGreaterThan(readsBeforeRecovery);
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(verdict).toContainText('Current complete evidence');
    await expect(actions.getByRole('button', { name: 'Load artifact' })).toBeEnabled();
    await expect(failure).toContainText(MONITOR_FAILURE_MESSAGE);
    await expect(matrix).toContainText(MONITOR_FAILURE_AGENT_ID);

    fixture.deleteOnNextRunRead();
    const readsBeforeDeletion = fixture.runRequestCount();
    await actions.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(fixture.runRequestCount).toBeGreaterThan(readsBeforeDeletion);
    await expect(verdict).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Select a distributed run' }))
        .toBeVisible();
    await expect(page.locator('[data-monitor-run-selector]')).toContainText(
        `Distributed run ${MONITOR_DISTRIBUTED_RUN_ID} is not available in the selected control run.`
    );
    await expect(failureRow(page)).toHaveCount(0);
    await expect(page.locator('[data-monitor-section="matrix"]')).toHaveCount(0);
});

test('confirms a visible armed Monitor cancellation and projects cancelled truth', async ({ context, page }) => {
    const fixture = await installRecipeConsoleMonitorFixture(context);
    fixture.setRunState('running');
    await page.goto(MONITOR_ROUTE);

    const actions = page.getByRole('region', { name: 'Monitor actions' });
    await actions.getByRole('button', { name: 'Arm Cancel', exact: true }).click();
    await expect(actions.getByRole('button', { name: 'Cancel armed', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');
    await actions.getByRole('button', { name: 'Cancel run', exact: true }).click();

    const dialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?'
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(MONITOR_DISTRIBUTED_RUN_ID);
    await expect(dialog).toContainText(MONITOR_CONTROL_RUN_ID);
    await expect(dialog).toContainText('running');
    await dialog.getByRole('button', { name: 'Cancel run', exact: true }).click();

    await expect.poll(fixture.cancelRequestCount).toBe(1);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-monitor-section="verdict"]'))
        .toHaveAttribute('data-run-state', 'cancelled');
    await expect(actions.getByRole('button', { name: 'Cancel run', exact: true }))
        .toBeDisabled();
});

test('browses secondary Monitor events with exact window truth', async ({ context, page }) => {
    const fixture = await installRecipeConsoleMonitorFixture(context);
    fixture.setAdditionalEventCount(45);
    await page.goto(MONITOR_ROUTE);

    const eventEvidence = page.locator('[data-monitor-section="timeline"] details')
        .filter({ has: page.locator('summary', { hasText: 'Events (' }) });
    await expect(eventEvidence.locator('summary')).toHaveText('Events (47)');
    await eventEvidence.locator('summary').click();
    const window = eventEvidence.getByRole('group', { name: 'Events window' });
    await expect(eventEvidence.locator('li')).toHaveCount(40);
    await expect(window.getByRole('status')).toHaveText(
        'Showing 1–40 of 47 events.'
    );
    await expect(eventEvidence.getByText(
        '7 events outside this render window and browseable.',
        {
            exact: true
        }
    )).toBeVisible();
    await expect(window.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await expect(window.getByRole('button', { name: 'Next' })).toBeEnabled();

    const url = page.url();
    await window.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(url);
    await expect(eventEvidence.locator('li')).toHaveCount(7);
    await expect(window.getByRole('status')).toHaveText(
        'Showing 41–47 of 47 events.'
    );
    await expect(eventEvidence.getByText(
        '40 events outside this render window and browseable.',
        {
            exact: true
        }
    )).toBeVisible();
    await expect(window.getByRole('button', { name: 'Previous' })).toBeEnabled();
    await expect(window.getByRole('button', { name: 'Next' })).toBeDisabled();
});

test('renders operational and control-truth transitions from live Monitor evidence', async ({ context, page }) => {
    const fixture = await installRecipeConsoleMonitorFixture(context);
    fixture.setSingleAgentFailure();
    fixture.failNextRunRead();

    await page.goto(MONITOR_ROUTE);
    await expect(page.locator('[data-monitor-run-selector]')).toContainText('Control offline');
    await expect(page.getByRole('heading', { name: 'Control evidence unavailable' }))
        .toBeVisible();
    await expect(page.locator('[data-monitor-section="verdict"]')).toHaveCount(0);

    fixture.recoverRunReads();
    await page.reload();
    const verdict = page.locator('[data-monitor-section="verdict"]');
    await expect(verdict).toHaveAttribute('data-run-state', 'failed');
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(verdict).toHaveAttribute('data-evidence-completeness', 'complete');
    await expect(page.locator('[data-monitor-section="matrix"] tbody tr')).toHaveCount(1);
    await expect(page.locator('[data-failure-key]')).toHaveCount(1);
    const actions = page.getByRole('region', { name: 'Monitor actions' });

    fixture.failDistributedRunReads();
    await refreshMonitor(page, fixture.runRequestCount);
    await expect(page.locator('[data-monitor-run-selector]')).toContainText('Partial live truth');
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'last-known');
    await expect(verdict).toHaveAttribute('data-evidence-completeness', 'partial');
    await expect(actions.getByRole('button', { name: 'Load artifact' })).toBeDisabled();
    await expect(actions.getByRole('button', { name: 'Cancel run' })).toBeDisabled();

    fixture.recoverDistributedRunReads();
    await refreshMonitor(page, fixture.runRequestCount);
    await expect(page.locator('[data-monitor-run-selector]')).toContainText('Complete live truth');
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(verdict).toHaveAttribute('data-evidence-completeness', 'complete');

    fixture.setRunState('running');
    fixture.setFailureAgentConnected(false);
    await refreshMonitor(page, fixture.runRequestCount);
    await expect(verdict).toHaveAttribute('data-run-state', 'running');
    await expect(verdict.locator('[data-status="running"]')).toContainText('Running');
    await page.getByRole('region', { name: 'Agent by phase matrix' })
        .getByRole('button', { name: MONITOR_FAILURE_AGENT_ID })
        .click();
    const reconnectInspector = monitorInspector(page);
    await expect(reconnectInspector).toHaveAttribute('data-selection-kind', 'agent');
    await expect(reconnectInspector.getByText('Connection', { exact: true }).locator('..'))
        .toContainText('Disconnected');
    await expect(reconnectInspector.getByText('Reconnects', { exact: true }).locator('..'))
        .toContainText('0');

    fixture.setFailureAgentConnected(true);
    await refreshMonitor(page, fixture.runRequestCount);
    await expect(reconnectInspector.getByText('Connection', { exact: true }).locator('..'))
        .toContainText('Connected');
    await expect(reconnectInspector.getByText('Reconnects', { exact: true }).locator('..'))
        .toContainText('1');
    const eventEvidence = page.locator('[data-monitor-section="timeline"] details')
        .filter({ has: page.locator('summary', { hasText: 'Events (' }) });
    await eventEvidence.locator('summary').click();
    await expect(eventEvidence).toContainText(
        'Agent reconnected after a transient control disconnect.'
    );

    for (
        const [state, status, label] of [
            ['passed', 'passed', 'Passed'],
            ['failed', 'failed', 'Failed'],
            ['timed-out', 'failed', 'Failed'],
            ['cancelled', 'warning', 'Attention']
        ] as const
    ) {
        fixture.setRunState(state);
        await refreshMonitor(page, fixture.runRequestCount);
        await expect(verdict).toHaveAttribute('data-run-state', state);
        await expect(verdict.locator(`[data-status="${status}"]`)).toContainText(label);
    }

    fixture.failNextRunRead();
    await refreshMonitor(page, fixture.runRequestCount);
    await expect(page.locator('[data-monitor-run-selector]')).toContainText('Last-known truth');
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'last-known');
    await expect(verdict).toHaveAttribute('data-evidence-completeness', 'complete');

    await page.reload();
    await expect(page.locator('[data-monitor-run-selector]')).toContainText('Control offline');
    await expect(page.getByRole('heading', { name: 'Control evidence unavailable' }))
        .toBeVisible();
    fixture.recoverRunReads();
    await page.reload();
    await expect(verdict).toHaveAttribute('data-run-state', 'cancelled');
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(verdict).toHaveAttribute('data-evidence-completeness', 'complete');
});

test('rejects an abort-ignoring late artifact response after Monitor context changes', async ({ context, page }) => {
    await installAbortIgnoringArtifactGate(context);
    const fixture = await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);

    const actions = page.getByRole('region', { name: 'Monitor actions' });
    await actions.getByRole('button', { name: 'Load artifact' }).click();
    await waitForAbortIgnoringArtifact(page);
    expect(fixture.artifactRequestCount()).toBe(0);
    await expect(actions).toHaveAttribute('aria-busy', 'true');

    await page.evaluate(() => {
        const url = new URL(location.href);
        url.searchParams.set('distributedRunId', 'monitor-distributed-other');
        history.pushState(null, '', url);
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page).toHaveURL(/distributedRunId=monitor-distributed-other/);
    await expect(page.getByRole('heading', { name: 'Select a distributed run' }))
        .toBeVisible();

    await releaseAbortIgnoringArtifact(page);
    await expect.poll(fixture.artifactRequestCount).toBe(1);
    await expect(page.locator('[data-operation-error]')).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(
        new RegExp(`distributedRunId=${MONITOR_DISTRIBUTED_RUN_ID}`)
    );
    const restoredActions = page.getByRole('region', { name: 'Monitor actions' });
    await expect(restoredActions).toHaveAttribute('aria-busy', 'false');
    await expect(restoredActions).toContainText('artifact not-loaded');
    await expect(restoredActions.locator('[data-operation-error]')).toHaveCount(0);
});
