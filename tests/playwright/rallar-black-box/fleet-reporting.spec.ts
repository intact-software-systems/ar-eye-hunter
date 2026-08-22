import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

type FleetAgentOutcome = Readonly<{
    agentId: string;
    label: Readonly<{
        agentId: string;
        region?: string;
        provider?: string;
        datacenter?: string;
        hostId?: string;
        agentPoolId?: string;
        deploymentId?: string;
        browserName?: string;
        browserVersion?: string;
        os?: string;
        tags?: readonly string[];
        location?: Readonly<{
            latitude: number;
            longitude: number;
            label?: string;
            precision?: 'exact' | 'approximate';
        }>;
    }>;
    state: 'passed' | 'failed' | 'missing' | 'timed-out';
    ok: boolean;
    missing: boolean;
    flaky: boolean;
    stale: boolean;
    commandCount: number;
    failedCommandCount: number;
    resultCount: number;
    eventCount: number;
    diagnosticCount: number;
    reconnectCount: number;
    durationMs?: number;
    lastHeartbeatAtEpochMs?: number;
    failureSignatureIds: readonly string[];
}>;

type FleetRunReport = Readonly<{
    fleetReportSchemaVersion: 1;
    distributedRunId: string;
    controlRunId: string;
    generatedAtEpochMs: number;
    state: 'passed' | 'failed' | 'timed-out';
    ok: boolean;
    group: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId: string;
    }>;
    recipeIds: readonly string[];
    runDurationMs: number;
    summary: Readonly<{
        agents: number;
        regions: number;
        passed: number;
        failed: number;
        missing: number;
        flaky: number;
        stale: number;
        passRate: number;
        failureGroups: number;
    }>;
    timing: Readonly<{
        run: Readonly<
            { count: number; minMs?: number; p50Ms?: number; p90Ms?: number; p95Ms?: number; maxMs?: number; }
        >;
        commands: Readonly<
            { count: number; minMs?: number; p50Ms?: number; p90Ms?: number; p95Ms?: number; maxMs?: number; }
        >;
    }>;
    agents: readonly FleetAgentOutcome[];
    regions: readonly unknown[];
    failureSignatures: readonly FailureSignature[];
    artifactRefs: Readonly<{
        distributedRun: string;
        controlRun: string;
        fleetReport: string;
    }>;
}>;

type FailureSignature = Readonly<{
    signatureId: string;
    category: 'command' | 'diagnostic' | 'readiness';
    title: string;
    normalizedMessage: string;
    code?: string;
    recipeId?: string;
    commandKind?: string;
    diagnosticTypeId?: string;
    transport?: string;
    count: number;
    firstSeenAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    affectedAgents: readonly string[];
    affectedRegions: readonly string[];
    affectedRuns: readonly string[];
    likelyCause: string;
    nextAction: string;
}>;

const REGIONS = [
    ['eu-north', 'hetzner', 'fsn1'],
    ['us-east', 'hetzner', 'ash'],
    ['ap-south', 'fly', 'bom'],
    ['sa-east', 'fly', 'gru']
] as const;

test('Fleet tab renders 20-agent heatmap, regional patterns, failures, timings, and exports', async ({ page }) => {
    const fixture = fleetFixture();
    const requestedUrls: string[] = [];
    await mockFleetApi(page, fixture, requestedUrls);

    await page.goto('/?provider=simulated&workspace=black-box-runner&tab=fleet&roomId=bb-group');

    await expect(page.getByRole('tab', { name: 'Fleet', exact: true }))
        .toHaveAttribute('aria-selected', 'true');
    const panel = page.locator('#panel-fleet');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Agent x Run Heatmap')).toBeVisible();
    await expect(panel.getByLabel('Fleet World Map')).toBeVisible();
    await expect(panel.locator('.fleet-map-marker')).toHaveCount(0);
    await expect(panel.locator('.fleet-map-region-marker')).toHaveCount(2);
    await expect(panel.getByText(/10 unresolved locations/)).toBeVisible();
    await expect(panel.getByText('No observed routes with map-ready endpoints.')).toBeVisible();
    await expect(panel.getByText('Region Summary')).toBeVisible();
    await expect(panel.getByText('Failure Signatures')).toBeVisible();
    await expect(panel.getByText('Timing Distributions')).toBeVisible();
    await expect(panel.locator('.fleet-summary-grid .metric').nth(1)).toContainText('20');
    await expect(panel.locator('.fleet-summary-grid .metric').nth(2)).toContainText('4');
    await expect(panel.locator('.fleet-agent-button')).toHaveCount(20);
    await expect(panel.locator('.fleet-table')).toContainText('eu-north');
    await expect(panel.locator('.fleet-table')).toContainText('us-east');

    await panel.getByRole('button', { name: /RTC lane mismatch/ }).click();
    await expect(panel.locator('.fleet-selected-failure')).toContainText('Inspect RTC lane');

    await panel.locator('.fleet-agent-button').filter({ hasText: 'agent-04' }).click();
    await expect(panel.locator('.fleet-agent-detail')).toContainText('agent-04');
    await expect(panel.locator('.fleet-agent-detail')).toContainText(/passed|failed/);

    await panel.getByRole('textbox', { name: 'Region' }).fill('eu-north');
    await expect(page).toHaveURL(/region=eu-north/);
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => requestedUrls.some((url) => url.includes('region=eu-north')))
        .toBe(true);

    await panel.getByRole('button', { name: 'Export report' }).click();
    await expect(panel.locator('.fleet-export-files')).toContainText('summary.md');
    await expect(panel.locator('.fleet-export-files')).toContainText('agent-results.csv');
});

test('Fleet world map restores layer state from the share URL', async ({ page }) => {
    await mockFleetApi(page, fleetFixture(), []);

    await page.goto(
        '/?provider=simulated&workspace=black-box-runner&tab=fleet&roomId=bb-group&fleetMapLayers=live-agents,failures'
    );

    const panel = page.locator('#panel-fleet');
    const historicalLayer = panel.getByRole('button', { name: /Historical regions/ });
    await expect(panel.getByLabel('Fleet World Map')).toBeVisible();
    await expect(historicalLayer).toHaveAttribute('aria-pressed', 'false');

    await historicalLayer.click();

    await expect(historicalLayer).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/fleetMapLayers=live-agents%2Chistorical-regions%2Cfailures/);
});

test('Fleet tab remains usable on mobile with the same 20-agent data', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockFleetApi(page, fleetFixture(), []);

    await page.goto('/?provider=simulated&workspace=black-box-runner&tab=fleet&roomId=bb-group');

    const panel = page.locator('#panel-fleet');
    await expect(panel.locator('.fleet-summary-grid')).toBeVisible();
    await expect(panel.getByText('Agent x Run Heatmap')).toBeVisible();
    await expect(panel.getByText('Failure Signatures')).toBeVisible();
    await expect(panel.locator('.fleet-agent-button').filter({ hasText: 'agent-01' })).toBeVisible();
    await expect(panel.getByRole('button', { name: /RTC lane mismatch/ })).toBeVisible();
});

for (
    const legacyFleetAlias of [
        'fleet',
        'fleet-report',
        'fleet-reports'
    ] as const
) {
    test(`keeps legacy tab=${legacyFleetAlias} on the active Fleet mount`, async ({ page }) => {
        await mockFleetApi(page, fleetFixture(), []);
        await page.goto(
            '/?provider=simulated&workspace=black-box-runner' +
                `&tab=${legacyFleetAlias}&roomId=bb-group`
        );

        await expect(page.locator('.app-shell')).toBeVisible();
        await expect(page.locator('.recipe-console')).toHaveCount(0);
        await expect(page.locator('[data-fleet-workspace]')).toHaveCount(0);
        await expect(page.getByRole('tab', { name: 'Fleet', exact: true }))
            .toHaveAttribute('aria-selected', 'true');
        const legacyFleet = page.locator('#panel-fleet');
        await expect(legacyFleet).toBeVisible();
        await expect(legacyFleet.locator('.runner-fleet-panel')).toHaveCount(1);
        await expect(legacyFleet.locator('.runner-fleet-panel')).toBeVisible();
        await expect(page.locator('.runner-fleet-panel')).toHaveCount(1);
        expect(new URL(page.url()).searchParams.get('tab'))
            .toBe(legacyFleetAlias);
        expect(new URL(page.url()).searchParams.get('experience'))
            .not.toBe('recipe-console');
    });
}

async function mockFleetApi(
    page: Page,
    fixture: ReturnType<typeof fleetFixture>,
    requestedUrls: string[]
): Promise<void> {
    await page.route(/\/runs(?:\?.*)?$/, async (route: Route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/runs') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ runs: [] })
            });
            return;
        }
        await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'not mocked' })
        });
    });
    await page.route('**/fleet/reports**', async (route: Route) => {
        const url = route.request().url();
        requestedUrls.push(url);
        const path = new URL(url).pathname;
        if (path.endsWith('/rebuild')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture.response)
            });
            return;
        }
        if (path.endsWith('/artifacts')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture.bundle)
            });
            return;
        }
        const singleMatch = path.match(/\/fleet\/reports\/([^/]+)$/);
        if (singleMatch) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture.reports[0])
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(fixture.response)
        });
    });
}

function fleetFixture() {
    const reports = Array.from({ length: 5 }, (_, index) => createFleetReport(index));
    const allAgents = new Set(reports.flatMap((report) => report.agents.map((agent) => agent.agentId)));
    const failed = reports.reduce((sum, report) => sum + report.summary.failed, 0);
    const passed = reports.reduce((sum, report) => sum + report.summary.passed, 0);
    const response = {
        reports,
        aggregate: {
            generatedAtEpochMs: Date.now(),
            reportCount: reports.length,
            runCount: reports.length,
            agentCount: allAgents.size,
            regionCount: REGIONS.length,
            passRate: passed / (passed + failed),
            staleAgentCount: 1,
            flakyAgentCount: 3,
            failureGroupCount: 2,
            timing: {
                runs: { count: reports.length, minMs: 1_600, p50Ms: 1_900, p90Ms: 2_300, p95Ms: 2_300, maxMs: 2_300 },
                commands: { count: 60, minMs: 80, p50Ms: 140, p90Ms: 260, p95Ms: 320, maxMs: 420 }
            },
            regions: [],
            failureSignatures: reports[0].failureSignatures
        }
    };
    const bundle = {
        fleetReportSchemaVersion: 1,
        distributedRunId: reports[0].distributedRunId,
        generatedAtEpochMs: Date.now(),
        files: {
            'fleet-report.json': JSON.stringify(reports[0]),
            'summary.md': '# Fleet Run Report\n\nState: failed',
            'agent-results.csv': 'agentId,region,provider,state',
            'failure-signatures.csv': 'signatureId,category,count'
        }
    };
    return { reports, response, bundle };
}

function createFleetReport(index: number): FleetRunReport {
    const runId = `dist-fleet-${String(5 - index).padStart(2, '0')}`;
    const failedAgents = new Set(
        index === 0
            ? ['agent-04', 'agent-09', 'agent-13', 'agent-18']
            : index === 1
            ? ['agent-04', 'agent-13']
            : index === 2
            ? ['agent-09']
            : index === 3
            ? ['agent-18']
            : []
    );
    const missingAgents = new Set(index === 2 ? ['agent-17'] : []);
    const agents = Array.from({ length: 20 }, (_, agentIndex) => {
        const ordinal = agentIndex + 1;
        const agentId = `agent-${String(ordinal).padStart(2, '0')}`;
        const [region, provider, datacenter] = REGIONS[agentIndex % REGIONS.length];
        const failed = failedAgents.has(agentId);
        const missing = missingAgents.has(agentId);
        const failureSignatureIds = failed
            ? ['sig-rtc-lane-mismatch', 'sig-assert-command']
            : missing
            ? ['sig-readiness-timeout']
            : [];
        return {
            agentId,
            label: {
                agentId,
                region,
                provider,
                datacenter,
                hostId: `${datacenter}-${ordinal}`,
                agentPoolId: 'global-browser-pool',
                deploymentId: 'deploy-2026-06-11',
                browserName: 'chromium',
                browserVersion: '126',
                os: 'linux',
                tags: [region, provider]
            },
            state: missing ? 'missing' : failed ? 'failed' : 'passed',
            ok: !failed && !missing,
            missing,
            flaky: ['agent-04', 'agent-09', 'agent-18'].includes(agentId),
            stale: agentId === 'agent-17',
            commandCount: 3,
            failedCommandCount: failed ? 1 : 0,
            resultCount: missing ? 2 : 3,
            eventCount: failed ? 9 : 5,
            diagnosticCount: failed ? 2 : 0,
            reconnectCount: agentId === 'agent-09' ? index + 1 : 0,
            durationMs: 120 + agentIndex * 8 + index * 20,
            lastHeartbeatAtEpochMs: Date.now() - (agentId === 'agent-17' ? 90_000 : 5_000),
            failureSignatureIds
        } satisfies FleetAgentOutcome;
    });
    const failed = agents.filter((agent) => agent.state === 'failed').length;
    const missing = agents.filter((agent) => agent.missing).length;
    const signatures = failureSignatures(runId, agents, index);
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId: runId,
        controlRunId: `control-${runId}`,
        generatedAtEpochMs: Date.now() - index * 30_000,
        state: failed > 0 || missing > 0 ? 'failed' : 'passed',
        ok: failed === 0 && missing === 0,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group'
        },
        recipeIds: ['composite-evidence', 'rtc-lane-check'],
        runDurationMs: 1_700 + index * 150,
        summary: {
            agents: agents.length,
            regions: REGIONS.length,
            passed: agents.length - failed - missing,
            failed,
            missing,
            flaky: agents.filter((agent) => agent.flaky).length,
            stale: agents.filter((agent) => agent.stale).length,
            passRate: (agents.length - failed - missing) / agents.length,
            failureGroups: signatures.length
        },
        timing: {
            run: { count: 1, minMs: 1_700, p50Ms: 1_700, p90Ms: 1_700, p95Ms: 1_700, maxMs: 1_700 },
            commands: { count: 60, minMs: 80, p50Ms: 140, p90Ms: 260, p95Ms: 320, maxMs: 420 }
        },
        agents,
        regions: [],
        failureSignatures: signatures,
        artifactRefs: {
            distributedRun: `distributed-run:${runId}`,
            controlRun: `control-run:${runId}`,
            fleetReport: `fleet-report:${runId}`
        }
    };
}

function failureSignatures(
    runId: string,
    agents: readonly FleetAgentOutcome[],
    index: number
): readonly FailureSignature[] {
    const failedAgents = agents.filter((agent) => agent.state === 'failed');
    const missingAgents = agents.filter((agent) => agent.missing);
    const failedRegions = [...new Set(failedAgents.map((agent) => agent.label.region ?? 'unknown'))];
    const signatures: FailureSignature[] = [];
    if (failedAgents.length > 0) {
        signatures.push({
            signatureId: 'sig-rtc-lane-mismatch',
            category: 'diagnostic',
            title: 'RTC lane mismatch',
            normalizedMessage: 'rtc lane mismatch while executing distributed run',
            diagnosticTypeId: 'rtc.lane.mismatch',
            transport: 'rtc',
            count: failedAgents.length,
            firstSeenAtEpochMs: Date.now() - index * 30_000,
            lastSeenAtEpochMs: Date.now() - index * 20_000,
            affectedAgents: failedAgents.map((agent) => agent.agentId),
            affectedRegions: failedRegions,
            affectedRuns: [runId],
            likelyCause: 'Runtime transport diagnostics correlated with the distributed run.',
            nextAction: 'Inspect RTC lane, peer, group, and topic evidence for affected agents.'
        });
        signatures.push({
            signatureId: 'sig-assert-command',
            category: 'command',
            title: 'Command assertion failed',
            normalizedMessage: 'expected first payload before timeout',
            code: 'ASSERT_TIMEOUT',
            recipeId: 'composite-evidence',
            commandKind: 'recipe.run',
            count: failedAgents.length,
            firstSeenAtEpochMs: Date.now() - index * 30_000,
            lastSeenAtEpochMs: Date.now() - index * 20_000,
            affectedAgents: failedAgents.map((agent) => agent.agentId),
            affectedRegions: failedRegions,
            affectedRuns: [runId],
            likelyCause: 'A recipe command failed on at least one agent.',
            nextAction: 'Open the failing command result and compare expected vs observed payload evidence.'
        });
    }
    if (missingAgents.length > 0) {
        signatures.push({
            signatureId: 'sig-readiness-timeout',
            category: 'readiness',
            title: 'Agent result missing',
            normalizedMessage: 'agent did not return a terminal result',
            code: 'MISSING_RESULT',
            count: missingAgents.length,
            firstSeenAtEpochMs: Date.now() - index * 30_000,
            lastSeenAtEpochMs: Date.now() - index * 20_000,
            affectedAgents: missingAgents.map((agent) => agent.agentId),
            affectedRegions: [...new Set(missingAgents.map((agent) => agent.label.region ?? 'unknown'))],
            affectedRuns: [runId],
            likelyCause: 'One or more agents did not complete the distributed command.',
            nextAction:
                'Inspect missing ACK agents and confirm they are logged in, connected, and not blocked on recipe load.'
        });
    }
    return signatures;
}
