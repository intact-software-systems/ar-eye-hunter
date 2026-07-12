import { expect, test, type Page } from '@playwright/test';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;

async function routeLiveEmptyControl(page: Page): Promise<void> {
    await page.route(CONTROL_ROUTE, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ runs: [], distributedRuns: [] }),
    }));
}

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
    await page.route(CONTROL_ROUTE, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(liveExecuteSnapshot()),
    }));
}

type ConceptCase = Readonly<{
    name: string;
    snapshot: string;
    viewport: Readonly<{ width: number; height: number }>;
    view: 'execute' | 'monitor' | 'tune';
    ready(page: Page): Promise<void>;
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
            const actions = page.getByRole('region', { name: 'Execute actions' });
            await expect(actions.getByRole('button', { name: 'Resolve targets' }))
                .toBeEnabled();
            await expect(actions.getByRole('button', { name: 'Create draft' }))
                .toBeDisabled();
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
            const matrix = page.locator('[data-landscape-matrix]');
            const distribution = page.getByRole('img', { name: 'Command duration distribution' });
            await expect(distribution).toBeVisible();
            expect((await matrix.boundingBox())?.y).toBeLessThanOrEqual(64);
            const distributionBounds = await distribution.boundingBox();
            expect((distributionBounds?.y ?? 0) + (distributionBounds?.height ?? 0))
                .toBeLessThanOrEqual(430);
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
        },
    },
];

test.describe('approved Signal Ledger concept fidelity', () => {
    for (const concept of CONCEPT_CASES) {
        test(concept.name, async ({ page }) => {
            await page.setViewportSize(concept.viewport);
            await page.clock.setFixedTime(new Date('2026-07-12T00:00:00.000Z'));
            if (concept.view === 'execute') {
                await routeLiveExecuteControl(page);
            } else {
                await routeLiveEmptyControl(page);
            }
            await page.goto(
                `/?provider=simulated&v=1&experience=recipe-console&view=${concept.view}`,
            );
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
                maxDiffPixelRatio: 0.01,
                scale: 'css',
            });
        });
    }
});
