import { describe, expect, it } from 'vitest';
import type {
    ControlFleetAgentLabel,
    ControlFleetAgentRunOutcome,
    ControlFleetFailureSignature,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';
import {
    deriveFleetReportAgentDetail,
    deriveFleetReportAnalysis,
    deriveFleetReportDisplaySummary,
    deriveFleetReportFailureRows,
    deriveFleetReportHeatmapRows,
    deriveFleetReportMissingLabelAgentIds,
    deriveFleetReportRegionRows,
    deriveFleetReportTimingDistribution,
    deriveFleetReportTimingGroupsByRecipe,
    deriveFleetReportTimingGroupsByRegion,
    sortFleetRunReports,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report-analysis.ts';

function agent(
    agentId: string,
    label: Omit<ControlFleetAgentLabel, 'agentId'> & { agentId?: string },
    state: ControlFleetAgentRunOutcome['state'],
    options: Partial<ControlFleetAgentRunOutcome> = {},
): ControlFleetAgentRunOutcome {
    return {
        agentId,
        label: label as ControlFleetAgentLabel,
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
    options: Partial<ControlFleetFailureSignature> = {},
): ControlFleetFailureSignature {
    return {
        signatureId,
        category: 'runtime',
        title: `Failure ${signatureId}`,
        normalizedMessage: signatureId,
        count,
        affectedAgents: [],
        affectedRegions: [],
        affectedRuns: [],
        likelyCause: 'Runtime failed.',
        nextAction: 'Inspect logs.',
        ...options,
    };
}

function report(
    distributedRunId: string,
    generatedAtEpochMs: number,
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
        generatedAtEpochMs,
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

describe('shared Fleet report analysis', () => {
    it('sorts reports newest-first with an exact run-id tie-break without mutation', () => {
        const runC = report('run-c', 3_000, []);
        const runB = report('run-b', 4_000, []);
        const runA = report('run-a', 4_000, []);
        const shuffled = [runC, runB, runA];
        const before = JSON.stringify(shuffled);

        expect(sortFleetRunReports(shuffled).map((entry) => entry.distributedRunId))
            .toEqual(['run-a', 'run-b', 'run-c']);
        expect(JSON.stringify(shuffled)).toBe(before);
        expect(shuffled).toEqual([runC, runB, runA]);
    });

    it('uses locale-independent code-unit ordering for operator-controlled ids', () => {
        const reports = [
            report('run-ä', 4_000, []),
            report('run-\u202e', 4_000, []),
            report('run-z', 4_000, []),
        ];

        expect(sortFleetRunReports(reports).map(entry => entry.distributedRunId))
            .toEqual(['run-z', 'run-ä', 'run-\u202e']);
    });

    it('indexes heatmap cells once and preserves every state plus missing cells', () => {
        const newest = report('run-new', 2_000, [
            agent('agent-b', { region: 'eu', provider: 'p1' }, 'failed'),
            agent('agent-a', { region: 'us', provider: 'p2' }, 'passed'),
            agent('agent-c', { provider: 'lab' }, 'missing'),
            agent('agent-d', { region: 'eu', provider: 'p1' }, 'running'),
            agent('agent-e', { region: 'eu', provider: 'p1' }, 'cancelled'),
            agent('agent-f', { region: 'eu', provider: 'p1' }, 'timed-out'),
            agent('agent-g', { region: 'eu', provider: 'p1' }, 'unknown'),
        ]);
        const older = report('run-old', 1_000, [
            agent('agent-a', { region: 'us', provider: 'p2' }, 'failed'),
            agent('agent-b', { region: 'eu', provider: 'p1' }, 'passed'),
        ]);
        const work = {
            reportVisits: 0,
            outcomeVisits: 0,
            indexInserts: 0,
            cellLookups: 0,
            failureSignatureVisits: 0,
        };

        const rows = deriveFleetReportHeatmapRows(
            [older, newest],
            [older, newest],
            { agentLimit: 20, runLimit: 20, work },
        );

        expect(rows.runs.map((entry) => entry.distributedRunId))
            .toEqual(['run-new', 'run-old']);
        expect(rows.rows.map((row) => row.agent.agentId)).toEqual([
            'agent-b',
            'agent-d',
            'agent-e',
            'agent-f',
            'agent-g',
            'agent-c',
            'agent-a',
        ]);
        expect(rows.rows.map((row) => row.cells.map((cell) => cell?.state)))
            .toContainEqual(['missing', undefined]);
        expect(rows.rows.flatMap((row) => row.cells).filter(Boolean)
            .map((cell) => cell?.state)).toEqual(expect.arrayContaining([
                'passed',
                'failed',
                'missing',
                'running',
                'cancelled',
                'timed-out',
                'unknown',
            ]));
        expect(work).toEqual({
            reportVisits: 2,
            outcomeVisits: 9,
            indexInserts: 9,
            cellLookups: 14,
            failureSignatureVisits: 0,
        });
    });

    it('derives legacy-compatible regions, missing labels, and bounded agent detail', () => {
        const reports = Array.from({ length: 14 }, (_, index) => report(
            `run-${String(index).padStart(2, '0')}`,
            20_000 - index,
            [
                agent('agent-a', { region: 'eu', provider: 'p1' },
                    index === 0 ? 'failed' : 'passed', {
                        durationMs: 10 + index,
                        reconnectCount: index,
                        diagnosticCount: 1,
                        stale: index === 0,
                        flaky: index === 1,
                        failureSignatureIds: index < 2 ? ['sig-b', 'sig-a'] : [],
                    }),
                agent('agent-b', { provider: 'lab' }, 'missing'),
                agent('agent-c', { region: 'eu', provider: 'p1' }, 'timed-out'),
            ],
        ));

        expect(deriveFleetReportRegionRows(reports)[0]).toMatchObject({
            region: 'eu',
            provider: 'p1',
            agentCount: 2,
            passed: 13,
            failed: 15,
            missing: 0,
            flaky: 1,
            stale: 1,
            dominantFailureSignatureId: 'sig-a',
        });
        expect(deriveFleetReportMissingLabelAgentIds(reports)).toEqual(['agent-b']);
        const detail = deriveFleetReportAgentDetail('agent-a', reports);
        expect(detail).toMatchObject({
            agent: { agentId: 'agent-a', state: 'failed' },
            totalRuns: 14,
            omittedRuns: 2,
            passed: 13,
            failed: 1,
            missing: 0,
            reconnectCount: 13,
            diagnosticCount: 14,
        });
        expect(detail?.runs).toHaveLength(12);
        expect(deriveFleetReportAgentDetail('agent-c', reports)).toMatchObject({
            failed: 14,
            passed: 0,
        });
        expect(deriveFleetReportAgentDetail('unknown', reports)).toBeUndefined();
    });

    it('groups persisted signature ids with exact unions and stable authority/order', () => {
        const newestAuthority = failure('sig-b', 1, {
            title: 'Newest title',
            normalizedMessage: 'newest',
            firstSeenAtEpochMs: 300,
            lastSeenAtEpochMs: 500,
            affectedAgents: ['agent-b'],
            affectedRegions: ['eu'],
            affectedRuns: ['external-z'],
        });
        const olderSame = failure('sig-b', 2, {
            title: 'Older title',
            normalizedMessage: 'older',
            firstSeenAtEpochMs: 100,
            lastSeenAtEpochMs: 400,
            affectedAgents: ['agent-a'],
            affectedRegions: ['us'],
            affectedRuns: ['external-a'],
        });
        const tie = failure('sig-a', 3, {
            firstSeenAtEpochMs: 200,
            lastSeenAtEpochMs: 500,
        });
        const reports = [
            report('run-old', 1_000, [], { failures: [olderSame] }),
            report('run-new', 2_000, [], { failures: [newestAuthority, tie] }),
        ];

        expect(deriveFleetReportFailureRows(reports)).toEqual([
            expect.objectContaining({
                signatureId: 'sig-a',
                count: 3,
                affectedRuns: ['run-new'],
            }),
            expect.objectContaining({
                signatureId: 'sig-b',
                title: 'Newest title',
                normalizedMessage: 'newest',
                count: 3,
                firstSeenAtEpochMs: 100,
                lastSeenAtEpochMs: 500,
                affectedAgents: ['agent-a', 'agent-b'],
                affectedRegions: ['eu', 'us'],
                affectedRuns: ['external-a', 'external-z', 'run-new', 'run-old'],
            }),
        ]);
    });

    it('uses nearest-rank timing and deterministic timing-group ties', () => {
        const values = [Number.NaN, 100, 5, 20, 10];
        expect(deriveFleetReportTimingDistribution(values)).toEqual({
            count: 4,
            minMs: 5,
            p50Ms: 10,
            p90Ms: 100,
            p95Ms: 100,
            maxMs: 100,
        });
        expect(values).toEqual([Number.NaN, 100, 5, 20, 10]);

        const reports = [
            report('run-b', 2_000, [
                agent('b', { region: 'z', provider: 'p' }, 'passed', {
                    durationMs: 20,
                }),
            ], { recipeIds: ['recipe-z'], runDurationMs: 20 }),
            report('run-a', 1_000, [
                agent('a', { region: 'a', provider: 'p' }, 'passed', {
                    durationMs: 20,
                }),
            ], { recipeIds: ['recipe-a'], runDurationMs: 20 }),
        ];
        expect(deriveFleetReportTimingGroupsByRegion(reports).map((row) => row.id))
            .toEqual(['a / p', 'z / p']);
        expect(deriveFleetReportTimingGroupsByRecipe(reports).map((row) => row.id))
            .toEqual(['recipe-a', 'recipe-z']);
    });

    it('keeps delimiter-bearing region/provider tuples distinct in rollups and timing', () => {
        const reports = [report('run-delimiters', 1_000, [
            agent('agent-left', {
                region: 'a / b',
                provider: 'c',
            }, 'failed', { durationMs: 10 }),
            agent('agent-right', {
                region: 'a',
                provider: 'b / c',
            }, 'passed', { durationMs: 20 }),
        ])];

        expect(deriveFleetReportRegionRows(reports).map(row => ({
            region: row.region,
            provider: row.provider,
            agentCount: row.agentCount,
            failed: row.failed,
        }))).toEqual([
            { region: 'a / b', provider: 'c', agentCount: 1, failed: 1 },
            { region: 'a', provider: 'b / c', agentCount: 1, failed: 0 },
        ]);
        const timing = deriveFleetReportTimingGroupsByRegion(reports);
        expect(new Set(timing.map(row => row.id)).size).toBe(2);
        expect(timing.map(row => ({
            label: row.label,
            count: row.timing.count,
            minMs: row.timing.minMs,
        }))).toEqual([
            { label: 'a / b / c', count: 1, minMs: 20 },
            { label: 'a / b / c', count: 1, minMs: 10 },
        ]);
    });

    it('uses aggregate fallback only when no accepted reports remain', () => {
        const response = {
            reports: [],
            aggregate: {
                generatedAtEpochMs: 1,
                reportCount: 2,
                runCount: 2,
                agentCount: 5,
                regionCount: 3,
                passRate: 0.75,
                staleAgentCount: 1,
                flakyAgentCount: 1,
                failureGroupCount: 4,
                timing: {
                    runs: { count: 2, p95Ms: 900 },
                    commands: { count: 0 },
                },
                regions: [],
                failureSignatures: [],
            },
        } satisfies ControlFleetReportsResponse;

        expect(deriveFleetReportDisplaySummary([], response)).toEqual({
            runs: 2,
            agents: 5,
            regions: 3,
            passRate: 0.75,
            failureGroups: 4,
            p95DurationMs: 900,
            stale: 1,
        });
    });

    it('builds a bounded composed model with exact linear indexing work', () => {
        const reports = Array.from({ length: 4 }, (_, runIndex) => report(
            `run-${runIndex}`,
            4_000 - runIndex,
            Array.from({ length: 6 }, (_, agentIndex) => agent(
                `agent-${agentIndex}`,
                { region: `region-${agentIndex % 2}`, provider: 'p' },
                agentIndex % 2 === 0 ? 'passed' : 'failed',
            )),
            {
                failures: [failure(`sig-${runIndex}`, 1)],
                recipeIds: [`recipe-${runIndex}`],
                runDurationMs: 100 + runIndex,
            },
        ));
        const before = JSON.stringify(reports);

        const analysis = deriveFleetReportAnalysis({
            reports: [...reports].reverse(),
            selectedAgentId: 'agent-0',
            limits: {
                heatmapAgentRows: 4,
                heatmapRunColumns: 3,
                regionRows: 1,
                failureRows: 2,
                timingGroups: 2,
                missingLabelAgentIds: 2,
                agentDetailRuns: 2,
            },
        });

        expect(analysis.heatmap).toMatchObject({
            totalAgentRows: 6,
            omittedAgentRows: 2,
            totalRunColumns: 4,
            omittedRunColumns: 1,
        });
        expect(analysis.heatmap.rows).toHaveLength(4);
        expect(analysis.heatmap.runs).toHaveLength(3);
        expect(analysis.regions).toMatchObject({ total: 2, omitted: 1 });
        expect(analysis.failures).toMatchObject({ total: 4, omitted: 2 });
        expect(analysis.selectedAgent).toMatchObject({
            totalRuns: 4,
            omittedRuns: 2,
        });
        expect(analysis.work).toEqual({
            reportVisits: 4,
            outcomeVisits: 24,
            indexInserts: 24,
            cellLookups: 12,
            failureSignatureVisits: 4,
        });
        expect(JSON.stringify(reports)).toBe(before);
    });
});
