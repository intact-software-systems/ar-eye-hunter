import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    ControlFleetAgentLabel,
    ControlFleetAgentRunOutcome,
    ControlFleetFailureSignature,
    ControlFleetRunReport,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';
import {
    applyFleetLabelOverrides,
    buildFleetShareUrl,
    fleetReportFilterFromUi,
    parseFleetLabelOverrides,
    readFleetFiltersFromUrl,
    readFleetWorldMapLayersFromUrl,
    writeFleetFiltersToSearchParams,
    writeFleetFiltersToUrl,
    writeFleetWorldMapLayersToSearchParams,
} from '../../../apps/rallar-black-box/src/legacy/runner/fleet/fleet-helpers.ts';
import {
    fleetAgentDetail,
    fleetHeatmapRows,
    fleetMissingLabelAgents,
    fleetRegionRows,
} from '../../../apps/rallar-black-box/src/legacy/runner/fleet/fleet-derivations.ts';
import {
    fleetDisplaySummary,
    fleetFailureRows,
} from '../../../apps/rallar-black-box/src/legacy/runner/fleet/fleet-rollups.ts';
import {
    fleetTimingDistribution,
    fleetTimingGroupsByRecipe,
    fleetTimingGroupsByRegion,
} from '../../../apps/rallar-black-box/src/legacy/runner/fleet/fleet-timing.ts';
import {
    fleetAgentStateTone,
    fleetCellTitle,
    fleetFailureTone,
    fleetRegionKey,
    fleetRegionLabel,
    shortSignatureId,
} from '../../../apps/rallar-black-box/src/legacy/runner/fleet/fleet-presentation.ts';
import type { FleetFilterState } from '../../../apps/rallar-black-box/src/legacy/runner/fleet/fleet-types.ts';

function agent(
    agentId: string,
    label: ControlFleetAgentLabel,
    state: ControlFleetAgentRunOutcome['state'],
    options: Partial<ControlFleetAgentRunOutcome> = {},
): ControlFleetAgentRunOutcome {
    return {
        agentId,
        label,
        state,
        ok: state === 'passed',
        missing: state === 'missing',
        flaky: false,
        stale: false,
        commandCount: 2,
        failedCommandCount: state === 'failed' ? 1 : 0,
        resultCount: 2,
        eventCount: 3,
        diagnosticCount: 0,
        reconnectCount: 0,
        durationMs: 100,
        failureSignatureIds: [],
        ...options,
    };
}

function failure(
    signatureId: string,
    count: number,
    runId: string,
    lastSeenAtEpochMs: number,
): ControlFleetFailureSignature {
    return {
        signatureId,
        category: 'runtime',
        title: `Failure ${signatureId}`,
        normalizedMessage: signatureId,
        count,
        firstSeenAtEpochMs: lastSeenAtEpochMs - 100,
        lastSeenAtEpochMs,
        affectedAgents: [`agent-${runId}`],
        affectedRegions: ['eu-north'],
        affectedRuns: [runId],
        likelyCause: 'Runtime failed.',
        nextAction: 'Inspect logs.',
    };
}

function report(
    distributedRunId: string,
    agents: readonly ControlFleetAgentRunOutcome[],
    options: Readonly<{
        recipeIds?: readonly string[];
        runDurationMs?: number;
        failures?: readonly ControlFleetFailureSignature[];
    }> = {},
): ControlFleetRunReport {
    const passed = agents.filter((entry) => entry.state === 'passed').length;
    const failed = agents.filter((entry) => entry.state === 'failed').length;
    const missing = agents.filter((entry) => entry.missing).length;
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        controlRunId: `control-${distributedRunId}`,
        generatedAtEpochMs: 10_000,
        state: failed > 0 ? 'failed' : 'passed',
        ok: failed === 0,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'fleet-group',
        },
        recipeIds: options.recipeIds ?? ['rtc-smoke'],
        runDurationMs: options.runDurationMs,
        summary: {
            agents: agents.length,
            regions: new Set(agents.map((entry) => entry.label.region)).size,
            passed,
            failed,
            missing,
            flaky: agents.filter((entry) => entry.flaky).length,
            stale: agents.filter((entry) => entry.stale).length,
            passRate: agents.length > 0 ? passed / agents.length : 0,
            failureGroups: options.failures?.length ?? 0,
        },
        timing: {
            run: { count: 1, p95Ms: options.runDurationMs },
            commands: { count: agents.length },
        },
        agents,
        regions: [],
        failureSignatures: options.failures ?? [],
        artifactRefs: {
            distributedRun: `distributed-run:${distributedRunId}`,
            controlRun: `control-run:control-${distributedRunId}`,
            fleetReport: `fleet-report:${distributedRunId}`,
        },
    };
}

function stubWindow(href: string): { replaced(): string } {
    let nextHref = '';
    vi.stubGlobal('window', {
        location: { href },
        history: {
            state: { retained: true },
            replaceState: (_state: unknown, _title: string, value: string) => {
                nextHref = value;
            },
        },
    });
    return { replaced: () => nextHref };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('fleet analysis helpers', () => {
    it('parses default, canonical, and legacy filter URLs and serializes known fields', () => {
        stubWindow('https://fleet.test/app?region=eu-north&timeWindow=7d&keep=yes#trace');
        expect(readFleetFiltersFromUrl()).toEqual({
            region: 'eu-north',
            provider: '',
            recipeId: '',
            groupId: '',
            state: '',
            window: '7d',
        });

        stubWindow('https://fleet.test/app?window=invalid&timeWindow=1h');
        expect(readFleetFiltersFromUrl().window).toBe('24h');

        const params = new URLSearchParams('keep=yes&region=old&window=1h');
        writeFleetFiltersToSearchParams(params, {
            region: '',
            provider: ' hetzner ',
            recipeId: 'rtc-smoke',
            groupId: '',
            state: 'failed',
            window: '7d',
        });
        expect(params.toString()).toBe(
            'keep=yes&window=7d&provider=+hetzner+&recipeId=rtc-smoke&state=failed',
        );

        const browser = stubWindow('https://fleet.test/app?keep=yes#trace');
        writeFleetFiltersToUrl({
            region: '',
            provider: '',
            recipeId: '',
            groupId: '',
            state: '',
            window: '24h',
        });
        expect(browser.replaced()).toBe('https://fleet.test/app?keep=yes#trace');
    });

    it('parses and serializes map layers in canonical order', () => {
        stubWindow('https://fleet.test/app');
        expect(readFleetWorldMapLayersFromUrl()).toEqual({
            'live-agents': true,
            'historical-regions': true,
            failures: true,
            'observed-routes': true,
        });
        stubWindow('https://fleet.test/app?fleetMapLayers=none');
        expect(readFleetWorldMapLayersFromUrl()).toEqual({
            'live-agents': false,
            'historical-regions': false,
            failures: false,
            'observed-routes': false,
        });
        stubWindow('https://fleet.test/app?fleetMapLayers=failures,invalid,live-agents');
        expect(readFleetWorldMapLayersFromUrl()).toEqual({
            'live-agents': true,
            'historical-regions': false,
            failures: true,
            'observed-routes': false,
        });
        const params = new URLSearchParams('keep=yes');
        writeFleetWorldMapLayersToSearchParams(params, {
            'live-agents': true,
            'historical-regions': true,
            failures: true,
            'observed-routes': true,
        });
        expect(params.has('fleetMapLayers')).toBe(false);
        writeFleetWorldMapLayersToSearchParams(params, {
            'live-agents': true,
            'historical-regions': false,
            failures: true,
            'observed-routes': true,
        });
        expect(params.get('fleetMapLayers')).toBe(
            'live-agents,failures,observed-routes',
        );
        writeFleetWorldMapLayersToSearchParams(params, {
            'live-agents': false,
            'historical-regions': false,
            failures: false,
            'observed-routes': false,
        });
        expect(params.get('fleetMapLayers')).toBe('none');
    });

    it('builds a fleet share URL without losing unrelated query or fragment state', () => {
        expect(buildFleetShareUrl(
            'https://fleet.test/app?keep=yes&mode=rallar&tab=media&region=old&window=1h#trace',
            {
                region: 'eu-north',
                provider: 'hetzner',
                recipeId: '',
                groupId: 'group-a',
                state: '',
                window: 'all',
            },
            {
                'live-agents': true,
                'historical-regions': false,
                failures: true,
                'observed-routes': false,
            },
        )).toBe(
            'https://fleet.test/app?keep=yes&mode=black-box-runner&tab=fleet&region=eu-north&window=all&provider=hetzner&groupId=group-a&fleetMapLayers=live-agents%2Cfailures#trace',
        );
    });

    it('builds fresh filter bounds and normalizes label overrides', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
        const filters: FleetFilterState = {
            region: ' eu-north ',
            provider: ' hetzner ',
            recipeId: ' rtc-smoke ',
            groupId: ' fleet-group ',
            state: ' failed ',
            window: '1h',
        };
        expect(fleetReportFilterFromUi(filters)).toEqual({
            region: 'eu-north',
            provider: 'hetzner',
            recipeId: 'rtc-smoke',
            groupId: 'fleet-group',
            state: 'failed',
            fromEpochMs: Date.now() - 60 * 60 * 1000,
        });
        expect(fleetReportFilterFromUi({ ...filters, window: '24h' }))
            .toHaveProperty('fromEpochMs', Date.now() - 24 * 60 * 60 * 1000);
        expect(fleetReportFilterFromUi({ ...filters, window: '7d' }))
            .toHaveProperty('fromEpochMs', Date.now() - 7 * 24 * 60 * 60 * 1000);
        expect(fleetReportFilterFromUi({ ...filters, window: 'all' }))
            .not.toHaveProperty('fromEpochMs');

        const parsed = parseFleetLabelOverrides(JSON.stringify({
            'agent-a': {
                region: ' eu-west ',
                provider: ' ',
                tags: [' alpha ', 7, ''],
            },
            ignored: 5,
        }));
        expect(parsed).toEqual({
            value: { 'agent-a': { region: 'eu-west', tags: ['alpha'] } },
        });
        expect(parseFleetLabelOverrides('[]').error).toBe(
            'Overrides must be an object keyed by agent id.',
        );
        expect(parseFleetLabelOverrides('{').error).toBeTruthy();

        const base = report('run-1', [agent('agent-a', {
            agentId: 'agent-a',
            region: 'eu-north',
            provider: 'hetzner',
            tags: ['base'],
        }, 'passed')]);
        const overridden = applyFleetLabelOverrides([base], parsed.value);
        expect(overridden[0].agents[0].label).toMatchObject({
            region: 'eu-west',
            provider: 'hetzner',
            tags: ['alpha'],
        });
        const inheritedTags = applyFleetLabelOverrides([base], {
            'agent-a': { region: 'eu-west' },
        });
        expect(inheritedTags[0].agents[0].label.tags).toEqual(['base']);
    });

    it('derives heatmap, regions, missing labels, and selected agent detail', () => {
        const newest = report('run-2', [
            agent('agent-b', { agentId: 'agent-b', region: 'eu-north', provider: 'hetzner' }, 'failed', {
                durationMs: 900,
                flaky: true,
                stale: true,
                reconnectCount: 3,
                diagnosticCount: 2,
                failureSignatureIds: ['sig-a'],
            }),
            agent('agent-a', { agentId: 'agent-a', region: 'us-east', provider: 'aws' }, 'passed', {
                durationMs: 100,
            }),
            agent('agent-c', { agentId: 'agent-c', provider: 'lab' }, 'missing'),
        ]);
        const older = report('run-1', [
            agent('agent-a', { agentId: 'agent-a', region: 'us-east', provider: 'aws' }, 'failed', {
                reconnectCount: 1,
                diagnosticCount: 1,
            }),
            agent('agent-b', { agentId: 'agent-b', region: 'eu-north', provider: 'hetzner' }, 'passed'),
        ]);
        const reports = [newest, older];

        const heatmap = fleetHeatmapRows(reports, reports);
        expect(heatmap.map((row) => row.agent.agentId))
            .toEqual(['agent-b', 'agent-c', 'agent-a']);
        expect(heatmap.find((row) => row.agent.agentId === 'agent-a'))
            .toMatchObject({
                agent: { state: 'passed' },
                cells: [{ state: 'passed' }, { state: 'failed' }],
            });
        expect(fleetRegionRows(reports).map((row) => [row.region, row.failed]))
            .toEqual([['eu-north', 1], ['us-east', 1], ['unlabeled', 0]]);
        expect(fleetMissingLabelAgents(reports)).toEqual(['agent-c']);
        expect(fleetAgentDetail('agent-a', reports)).toMatchObject({
            agent: { state: 'passed' },
            runs: [
                { run: { distributedRunId: 'run-2' } },
                { run: { distributedRunId: 'run-1' } },
            ],
            passed: 1,
            failed: 1,
            missing: 0,
            reconnectCount: 1,
            diagnosticCount: 1,
        });
        expect(fleetAgentDetail('unknown', reports)).toBeUndefined();
    });

    it('preserves the extracted legacy locale ordering for non-ASCII labels', () => {
        const reports = [
            report('run-z', [
                agent('agent-z', {
                    agentId: 'agent-z',
                    region: 'z',
                    provider: 'provider',
                }, 'passed'),
            ]),
            report('run-umlaut', [
                agent('agent-umlaut', {
                    agentId: 'agent-umlaut',
                    region: 'ä',
                    provider: 'provider',
                }, 'passed'),
            ]),
        ];
        const expectedRegions = ['z', 'ä']
            .sort((left, right) => left.localeCompare(right));

        expect(fleetHeatmapRows(reports, reports).map((row) => row.region))
            .toEqual(expectedRegions);
        expect(fleetRegionRows(reports).map((row) => row.region))
            .toEqual(expectedRegions);
    });

    it('rolls up summaries, failures, and nearest-rank timing groups', () => {
        const first = report('run-1', [
            agent('agent-a', { agentId: 'agent-a', region: 'eu', provider: 'p1' }, 'passed', { durationMs: 10 }),
            agent('agent-b', { agentId: 'agent-b', region: 'eu', provider: 'p1' }, 'failed', { durationMs: 100, stale: true }),
        ], {
            runDurationMs: 1_000,
            recipeIds: ['recipe-a'],
            failures: [failure('sig-a', 2, 'run-1', 200)],
        });
        const second = report('run-2', [
            agent('agent-a', { agentId: 'agent-a', region: 'eu', provider: 'p1' }, 'passed', { durationMs: 20 }),
        ], {
            runDurationMs: 2_000,
            recipeIds: ['recipe-a', 'recipe-b'],
            failures: [failure('sig-a', 1, 'run-2', 400)],
        });
        const reports = [first, second];
        expect(fleetDisplaySummary(reports, undefined)).toEqual({
            runs: 2,
            agents: 2,
            regions: 1,
            passRate: 2 / 3,
            failureGroups: 1,
            p95DurationMs: 2_000,
            stale: 1,
        });
        expect(fleetFailureRows(reports)[0]).toMatchObject({
            signatureId: 'sig-a',
            count: 3,
            firstSeenAtEpochMs: 100,
            lastSeenAtEpochMs: 400,
            affectedRuns: ['run-1', 'run-2'],
        });
        expect(fleetTimingDistribution([Number.NaN, 5, 10, 20, 100])).toEqual({
            count: 4,
            minMs: 5,
            p50Ms: 10,
            p90Ms: 100,
            p95Ms: 100,
            maxMs: 100,
        });
        expect(fleetTimingGroupsByRegion(reports)[0]).toMatchObject({
            id: 'eu / p1',
            timing: { count: 3, p95Ms: 100 },
        });
        expect(fleetTimingGroupsByRecipe(reports).map((group) => group.id))
            .toEqual(['recipe-a', 'recipe-b']);
    });

    it('keeps fleet presentation labels, tones, and cell titles stable', () => {
        const label = { agentId: 'agent-a', region: 'eu', provider: 'p1' };
        const failed = agent('agent-a', label, 'failed');
        expect(fleetRegionKey(label)).toBe('eu / p1');
        expect(fleetRegionLabel({ agentId: 'agent-b' })).toBe(
            'unlabeled / unknown provider',
        );
        expect([
            fleetAgentStateTone('passed'),
            fleetAgentStateTone('failed'),
            fleetAgentStateTone('missing'),
            fleetAgentStateTone('running'),
            fleetAgentStateTone(undefined),
        ]).toEqual(['good', 'bad', 'warn', 'active', 'muted']);
        expect([
            fleetFailureTone('runtime'),
            fleetFailureTone('diagnostic'),
            fleetFailureTone('readiness'),
            fleetFailureTone('unknown'),
        ]).toEqual(['bad', 'warn', 'active', 'muted']);
        expect(fleetCellTitle(undefined)).toBe(
            'No result for this agent and run',
        );
        expect(fleetCellTitle(failed)).toBe(
            'agent-a: failed, 1 failed commands',
        );
        expect(shortSignatureId(undefined)).toBe('-');
        expect(shortSignatureId('1234567890123456789')).toBe(
            '123456789012345678...',
        );
    });
});
