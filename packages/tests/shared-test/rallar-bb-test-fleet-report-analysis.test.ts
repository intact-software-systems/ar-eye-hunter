import { describe, expect, it } from 'vitest';
import {
    createFleetReportAnalysisCollection,
    deriveFleetReportAgentDetail,
    deriveFleetReportAgentDetailWindow,
    deriveFleetReportAnalysis,
    deriveFleetReportAnalysisFromCollection,
    deriveFleetReportDisplaySummary,
    deriveFleetReportFailureRows,
    deriveFleetReportFailureWindow,
    deriveFleetReportHeatmapRows,
    deriveFleetReportHeatmapWindow,
    deriveFleetReportMissingLabelAgentIds,
    deriveFleetReportMissingLabelAgentIdWindow,
    deriveFleetReportRecipeTimingWindow,
    deriveFleetReportRegionRows,
    deriveFleetReportRegionTimingWindow,
    deriveFleetReportRegionWindow,
    deriveFleetReportTimingDistribution,
    deriveFleetReportTimingGroupsByRecipe,
    deriveFleetReportTimingGroupsByRegion,
    sortFleetRunReports,
    type FleetReportAnalysisCollection,
    type FleetReportBoundedWindow,
    type FleetReportWindowRequest
} from '../../../packages/shared-test/rallar-bb-test/fleet-report-analysis.ts';
import * as fleetReportAnalysis from '../../../packages/shared-test/rallar-bb-test/fleet-report-analysis.ts';
import { validateControlFleetRunReportCollection } from '../../../packages/shared-test/rallar-bb-test/fleet-report-validation.ts';
import type {
    ControlFleetAgentLabel,
    ControlFleetAgentRunOutcome,
    ControlFleetFailureSignature,
    ControlFleetReportsResponse,
    ControlFleetRunReport
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';

function agent(
    agentId: string,
    label: Omit<ControlFleetAgentLabel, 'agentId'> & { agentId?: string; },
    state: ControlFleetAgentRunOutcome['state'],
    options: Partial<ControlFleetAgentRunOutcome> = {}
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
        ...options
    };
}

function failure(
    signatureId: string,
    count: number,
    options: Partial<ControlFleetFailureSignature> = {}
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
        ...options
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
    }> = {}
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
            groupId: 'fleet-group'
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
            failureGroups: options.failures?.length ?? 0
        },
        timing: {
            run: { count: 1, p95Ms: options.runDurationMs },
            commands: { count: agents.length }
        },
        agents,
        regions: [],
        failureSignatures: options.failures ?? [],
        artifactRefs: {
            distributedRun: `distributed-run:${distributedRunId}`,
            controlRun: `control-run:control-${distributedRunId}`,
            fleetReport: `fleet-report:${distributedRunId}`
        }
    };
}

const FLEET_TRAVERSAL_FUNCTIONS = [
    'createFleetReportAnalysisCollection',
    'deriveFleetReportAnalysisFromCollection',
    'deriveFleetReportHeatmapWindow',
    'deriveFleetReportRegionWindow',
    'deriveFleetReportFailureWindow',
    'deriveFleetReportRegionTimingWindow',
    'deriveFleetReportRecipeTimingWindow',
    'deriveFleetReportMissingLabelAgentIdWindow',
    'deriveFleetReportAgentDetailWindow'
] as const;

function traversalReports(): readonly ControlFleetRunReport[] {
    const recipes = Array.from(
        { length: 55 },
        (_, index) => `recipe-${String(index).padStart(2, '0')}`
    );
    return Array.from({ length: 29 }, (_, runIndex) =>
        report(
            `run-${String(runIndex).padStart(2, '0')}`,
            100_000 - runIndex,
            Array.from({ length: 90 }, (_, agentIndex) =>
                agent(
                    `agent-${String(agentIndex).padStart(2, '0')}`,
                    { region: `region-${String(agentIndex).padStart(2, '0')}` },
                    agentIndex % 3 === 0 ? 'failed' : 'passed',
                    { durationMs: agentIndex + runIndex + 1 }
                )),
            {
                recipeIds: recipes,
                runDurationMs: 1_000 + runIndex,
                failures: runIndex === 0
                    ? Array.from(
                        { length: 55 },
                        (_, index) =>
                            failure(
                                `signature-${String(index).padStart(2, '0')}`,
                                1
                            )
                    )
                    : []
            }
        ));
}

function expectCompleteWindowTraversal<T>(
    input: Readonly<{
        label: string;
        collection: FleetReportAnalysisCollection;
        expectedItems: readonly T[];
        project: (
            collection: FleetReportAnalysisCollection,
            request: FleetReportWindowRequest
        ) => FleetReportBoundedWindow<T>;
        identity: (item: T) => string;
        maximumItems: number;
    }>
): void {
    const visited: string[] = [];
    const starts: number[] = [];
    let startIndex = 0;
    while (startIndex < input.expectedItems.length) {
        const window = input.project(input.collection, { startIndex });
        starts.push(window.startIndex);
        expect(window.items.length, input.label).toBeLessThanOrEqual(
            input.maximumItems
        );
        visited.push(...window.items.map(input.identity));
        expect(window.startIndex, input.label).toBe(startIndex);
        expect(window.endIndexExclusive, input.label).toBeGreaterThan(startIndex);
        startIndex = window.endIndexExclusive;
    }
    const expected = input.expectedItems.map(input.identity);
    expect(starts.length, `${input.label} first/middle/final windows`)
        .toBeGreaterThanOrEqual(3);
    expect(starts[0], input.label).toBe(0);
    expect(visited, input.label).toEqual(expected);
    expect(new Set(visited).size, input.label).toBe(expected.length);
}

describe('shared Fleet report analysis', () => {
    it('exports the reusable indexed collection and bounded traversal projections', () => {
        for (const name of FLEET_TRAVERSAL_FUNCTIONS) {
            expect(
                (fleetReportAnalysis as Record<string, unknown>)[name],
                name
            ).toBeTypeOf('function');
        }
    });

    it('traverses every bounded list and selected-agent run without gaps or duplicates', () => {
        const collection = createFleetReportAnalysisCollection({
            reports: traversalReports()
        });

        expectCompleteWindowTraversal({
            label: 'regions',
            collection,
            expectedItems: collection.regions,
            project: deriveFleetReportRegionWindow,
            identity: (row) => `${row.region}/${row.provider ?? 'unknown'}`,
            maximumItems: 24
        });
        expectCompleteWindowTraversal({
            label: 'failures',
            collection,
            expectedItems: collection.failures,
            project: deriveFleetReportFailureWindow,
            identity: (row) => row.signatureId,
            maximumItems: 24
        });
        expectCompleteWindowTraversal({
            label: 'region timing',
            collection,
            expectedItems: collection.regionTiming,
            project: deriveFleetReportRegionTimingWindow,
            identity: (row) => row.id,
            maximumItems: 24
        });
        expectCompleteWindowTraversal({
            label: 'recipe timing',
            collection,
            expectedItems: collection.recipeTiming,
            project: deriveFleetReportRecipeTimingWindow,
            identity: (row) => row.id,
            maximumItems: 24
        });
        expectCompleteWindowTraversal({
            label: 'missing labels',
            collection,
            expectedItems: collection.missingLabelAgentIds,
            project: deriveFleetReportMissingLabelAgentIdWindow,
            identity: (agentId) => agentId,
            maximumItems: 40
        });

        expect(
            deriveFleetReportRegionWindow(
                collection,
                { startIndex: 25 }
            ).startIndex
        ).toBe(24);
        expect(
            deriveFleetReportRegionWindow(
                collection,
                { startIndex: 999_999 }
            ).startIndex
        ).toBe(72);
        expect(
            deriveFleetReportRegionWindow(
                collection,
                { startIndex: -20 }
            ).startIndex
        ).toBe(0);
        expect(
            deriveFleetReportRegionWindow(
                collection,
                { startIndex: Number.NaN }
            ).startIndex
        ).toBe(0);

        const expectedRunIds = collection.reports.map(
            (entry: ControlFleetRunReport) => entry.distributedRunId
        );
        const visitedRunIds: string[] = [];
        let runStartIndex = 0;
        while (runStartIndex < expectedRunIds.length) {
            const detail = deriveFleetReportAgentDetailWindow(
                'agent-00',
                collection,
                {
                    startIndex: runStartIndex
                }
            );
            if (!detail) {
                throw new Error('Expected agent-00 detail');
            }
            expect(detail.runs).toHaveLength(
                Math.min(12, expectedRunIds.length - runStartIndex)
            );
            visitedRunIds.push(...detail.runs.map(
                (entry) => entry.run.distributedRunId
            ));
            expect(detail.startIndex).toBe(runStartIndex);
            runStartIndex = detail.endIndexExclusive;
        }
        expect(visitedRunIds).toEqual(expectedRunIds);
        expect(new Set(visitedRunIds).size).toBe(expectedRunIds.length);
        expect(deriveFleetReportAgentDetailWindow(
            'agent-00',
            collection,
            { startIndex: 13 }
        ))
            .toMatchObject({ startIndex: 12, endIndexExclusive: 24 });
        expect(deriveFleetReportAgentDetailWindow(
            'agent-00',
            collection,
            { startIndex: 999_999 }
        ))
            .toMatchObject({ startIndex: 24, endIndexExclusive: 29 });
    });

    it('slices repeated agent-detail windows without rereading historical aggregates', () => {
        const aggregateFields = new Set<PropertyKey>([
            'state',
            'missing',
            'reconnectCount',
            'diagnosticCount'
        ]);
        let aggregateReads = 0;
        const reports = traversalReports().map((entry) => ({
            ...entry,
            agents: entry.agents.map((outcome) =>
                outcome.agentId === 'agent-00'
                    ? new Proxy(outcome, {
                        get(target, property, receiver) {
                            if (aggregateFields.has(property)) {
                                aggregateReads += 1;
                            }
                            return Reflect.get(target, property, receiver);
                        }
                    })
                    : outcome
            )
        }));
        const collection = createFleetReportAnalysisCollection({ reports });
        const readsAfterIndex = aggregateReads;
        const workAfterIndex = { ...collection.work };

        const windows = [0, 12, 24].map((startIndex) =>
            deriveFleetReportAgentDetailWindow(
                'agent-00',
                collection,
                { startIndex }
            )
        );

        expect(windows.map((window) =>
            window?.runs.map(
                (entry) => entry.run.distributedRunId
            )
        )).toEqual([
            collection.reports.slice(0, 12).map((entry) => entry.distributedRunId),
            collection.reports.slice(12, 24).map((entry) => entry.distributedRunId),
            collection.reports.slice(24).map((entry) => entry.distributedRunId)
        ]);
        expect(windows.map((window) => ({
            passed: window?.passed,
            failed: window?.failed,
            missing: window?.missing,
            reconnectCount: window?.reconnectCount,
            diagnosticCount: window?.diagnosticCount
        }))).toEqual(Array.from({ length: 3 }, () => ({
            passed: 0,
            failed: 29,
            missing: 0,
            reconnectCount: 0,
            diagnosticCount: 0
        })));
        expect(aggregateReads).toBe(readsAfterIndex);
        expect(collection.work).toEqual(workAfterIndex);
    });

    it('caps heatmap windows at 32 by 8 and looks up only visible cells', () => {
        const collection = createFleetReportAnalysisCollection({
            reports: traversalReports()
        });
        const before = { ...collection.work };
        const middle = deriveFleetReportHeatmapWindow(collection, {
            agentStartIndex: 33,
            runStartIndex: 9,
            agentLimit: 9_999,
            runLimit: 9_999
        });

        expect(middle).toMatchObject({
            agentStartIndex: 32,
            agentEndIndexExclusive: 64,
            runStartIndex: 8,
            runEndIndexExclusive: 16,
            totalAgentRows: 90,
            totalRunColumns: 29
        });
        expect(middle.rows).toHaveLength(32);
        expect(middle.runs).toHaveLength(8);
        expect(collection.work).toEqual({
            ...before,
            cellLookups: before.cellLookups + 32 * 8
        });

        const visitedAgents: string[] = [];
        for (let startIndex = 0; startIndex < 90; startIndex += 32) {
            const cellLookups = collection.work.cellLookups;
            const window = deriveFleetReportHeatmapWindow(collection, {
                agentStartIndex: startIndex,
                runLimit: 1
            });
            visitedAgents.push(...window.rows.map((row) => row.agent.agentId));
            expect(collection.work.cellLookups - cellLookups)
                .toBe(window.rows.length * window.runs.length);
        }
        expect(visitedAgents).toEqual(
            Array.from(
                { length: 90 },
                (_, index) => `agent-${String(index).padStart(2, '0')}`
            )
        );
        expect(new Set(visitedAgents).size).toBe(90);

        const visitedRuns: string[] = [];
        for (let startIndex = 0; startIndex < 29; startIndex += 8) {
            const cellLookups = collection.work.cellLookups;
            const window = deriveFleetReportHeatmapWindow(collection, {
                agentLimit: 1,
                runStartIndex: startIndex
            });
            visitedRuns.push(...window.runs.map((entry) => entry.distributedRunId));
            expect(collection.work.cellLookups - cellLookups)
                .toBe(window.rows.length * window.runs.length);
        }
        expect(visitedRuns).toEqual(collection.reports.map(
            (entry) => entry.distributedRunId
        ));
        expect(new Set(visitedRuns).size).toBe(29);

        expect(deriveFleetReportHeatmapWindow(collection, {
            agentStartIndex: 999_999,
            runStartIndex: 999_999
        })).toMatchObject({
            agentStartIndex: 64,
            agentEndIndexExclusive: 90,
            runStartIndex: 24,
            runEndIndexExclusive: 29
        });
    });

    it('uses a collision-safe heatmap tie-break for separator-bearing labels', () => {
        const left = agent('z/w', { region: 'x', provider: 'y' }, 'passed');
        const right = agent('w', { region: 'x/y', provider: 'z' }, 'passed');
        const forward = deriveFleetReportHeatmapRows([
            report('run-collision', 1_000, [left, right])
        ]).rows.map((row) => row.agent.agentId);
        const reversed = deriveFleetReportHeatmapRows([
            report('run-collision', 1_000, [right, left])
        ]).rows.map((row) => row.agent.agentId);

        expect(forward).toEqual(['z/w', 'w']);
        expect(reversed).toEqual(forward);
    });

    it('reuses one indexed collection for the compatibility first window', () => {
        const reports = traversalReports();
        const collection = createFleetReportAnalysisCollection({ reports });
        deriveFleetReportHeatmapWindow(collection, {
            agentStartIndex: 64,
            runStartIndex: 24
        });
        const projected = deriveFleetReportAnalysisFromCollection(collection, {
            selectedAgentId: 'agent-00'
        });
        const compatibility = deriveFleetReportAnalysis({
            reports,
            selectedAgentId: 'agent-00'
        });

        expect(projected).toEqual(compatibility);
        expect(projected.summary).toBe(collection.summary);
        expect(projected.regions.items[0]).toBe(collection.regions[0]);
        expect(projected.failures.items[0]).toBe(collection.failures[0]);
        expect(projected.work).toEqual({
            reportVisits: 29,
            outcomeVisits: 2_610,
            indexInserts: 2_610,
            cellLookups: 32 * 8,
            failureSignatureVisits: 55
        });
    });

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
            report('run-z', 4_000, [])
        ];

        expect(sortFleetRunReports(reports).map((entry) => entry.distributedRunId))
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
            agent('agent-g', { region: 'eu', provider: 'p1' }, 'unknown')
        ]);
        const older = report('run-old', 1_000, [
            agent('agent-a', { region: 'us', provider: 'p2' }, 'failed'),
            agent('agent-b', { region: 'eu', provider: 'p1' }, 'passed')
        ]);
        const work = {
            reportVisits: 0,
            outcomeVisits: 0,
            indexInserts: 0,
            cellLookups: 0,
            failureSignatureVisits: 0
        };

        const rows = deriveFleetReportHeatmapRows(
            [older, newest],
            [older, newest],
            { agentLimit: 20, runLimit: 20, work }
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
            'agent-a'
        ]);
        expect(rows.rows.map((row) => row.cells.map((cell) => cell?.state)))
            .toContainEqual(['missing', undefined]);
        expect(
            rows.rows.flatMap((row) => row.cells).filter(Boolean)
                .map((cell) => cell?.state)
        ).toEqual(expect.arrayContaining([
            'passed',
            'failed',
            'missing',
            'running',
            'cancelled',
            'timed-out',
            'unknown'
        ]));
        expect(work).toEqual({
            reportVisits: 2,
            outcomeVisits: 9,
            indexInserts: 9,
            cellLookups: 14,
            failureSignatureVisits: 0
        });
    });

    it('derives legacy-compatible regions, missing labels, and bounded agent detail', () => {
        const reports = Array.from({ length: 14 }, (_, index) =>
            report(
                `run-${String(index).padStart(2, '0')}`,
                20_000 - index,
                [
                    agent('agent-a', { region: 'eu', provider: 'p1' }, index === 0 ? 'failed' : 'passed', {
                        durationMs: 10 + index,
                        reconnectCount: index,
                        diagnosticCount: 1,
                        stale: index === 0,
                        flaky: index === 1,
                        failureSignatureIds: index < 2 ? ['sig-b', 'sig-a'] : []
                    }),
                    agent('agent-b', { provider: 'lab' }, 'missing'),
                    agent('agent-c', { region: 'eu', provider: 'p1' }, 'timed-out')
                ]
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
            dominantFailureSignatureId: 'sig-a'
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
            diagnosticCount: 14
        });
        expect(detail?.runs).toHaveLength(12);
        expect(deriveFleetReportAgentDetail('agent-c', reports)).toMatchObject({
            failed: 14,
            passed: 0
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
            affectedRuns: ['external-z']
        });
        const olderSame = failure('sig-b', 2, {
            title: 'Older title',
            normalizedMessage: 'older',
            firstSeenAtEpochMs: 100,
            lastSeenAtEpochMs: 400,
            affectedAgents: ['agent-a'],
            affectedRegions: ['us'],
            affectedRuns: ['external-a']
        });
        const tie = failure('sig-a', 3, {
            firstSeenAtEpochMs: 200,
            lastSeenAtEpochMs: 500
        });
        const reports = [
            report('run-old', 1_000, [], { failures: [olderSame] }),
            report('run-new', 2_000, [], { failures: [newestAuthority, tie] })
        ];

        expect(deriveFleetReportFailureRows(reports)).toEqual([
            expect.objectContaining({
                signatureId: 'sig-a',
                count: 3,
                affectedRuns: ['run-new']
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
                affectedRuns: ['external-a', 'external-z', 'run-new', 'run-old']
            })
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
            maxMs: 100
        });
        expect(values).toEqual([Number.NaN, 100, 5, 20, 10]);

        const reports = [
            report('run-b', 2_000, [
                agent('b', { region: 'z', provider: 'p' }, 'passed', {
                    durationMs: 20
                })
            ], { recipeIds: ['recipe-z'], runDurationMs: 20 }),
            report('run-a', 1_000, [
                agent('a', { region: 'a', provider: 'p' }, 'passed', {
                    durationMs: 20
                })
            ], { recipeIds: ['recipe-a'], runDurationMs: 20 })
        ];
        expect(deriveFleetReportTimingGroupsByRegion(reports).map((row) => row.id))
            .toEqual(['a / p', 'z / p']);
        expect(deriveFleetReportTimingGroupsByRecipe(reports).map((row) => row.id))
            .toEqual(['recipe-a', 'recipe-z']);
    });

    it('keeps delimiter-bearing region/provider tuples distinct in rollups and timing', () => {
        const reports = [report('run-delimiters', 1_000, [
            agent(
                'agent-left',
                {
                    region: 'a / b',
                    provider: 'c'
                },
                'failed',
                { durationMs: 10 }
            ),
            agent(
                'agent-right',
                {
                    region: 'a',
                    provider: 'b / c'
                },
                'passed',
                { durationMs: 20 }
            )
        ])];

        expect(
            deriveFleetReportRegionRows(reports).map((row) => ({
                region: row.region,
                provider: row.provider,
                agentCount: row.agentCount,
                failed: row.failed
            }))
        ).toEqual([
            { region: 'a / b', provider: 'c', agentCount: 1, failed: 1 },
            { region: 'a', provider: 'b / c', agentCount: 1, failed: 0 }
        ]);
        const timing = deriveFleetReportTimingGroupsByRegion(reports);
        expect(new Set(timing.map((row) => row.id)).size).toBe(2);
        expect(timing.map((row) => ({
            label: row.label,
            count: row.timing.count,
            minMs: row.timing.minMs
        }))).toEqual([
            { label: 'a / b / c', count: 1, minMs: 20 },
            { label: 'a / b / c', count: 1, minMs: 10 }
        ]);
    });

    it('keeps a missing provider distinct from the literal provider unknown', () => {
        const reports = [report('run-provider-sentinels', 1_000, [
            agent('agent-missing', { region: 'eu' }, 'failed', {
                durationMs: 10
            }),
            agent(
                'agent-literal',
                {
                    region: 'eu',
                    provider: 'unknown'
                },
                'passed',
                { durationMs: 20 }
            )
        ])];

        expect(
            deriveFleetReportRegionRows(reports).map((row) => ({
                provider: row.provider,
                agentCount: row.agentCount,
                failed: row.failed
            }))
        ).toEqual([
            { provider: undefined, agentCount: 1, failed: 1 },
            { provider: 'unknown', agentCount: 1, failed: 0 }
        ]);
        const timing = deriveFleetReportTimingGroupsByRegion(reports);
        expect(timing).toHaveLength(2);
        expect(new Set(timing.map((row) => row.id)).size).toBe(2);
        expect(timing.map((row) => row.label)).toEqual([
            'eu / unknown',
            'eu / unknown'
        ]);
    });

    it('analyzes a validated lone-surrogate operator label without throwing', () => {
        const loneSurrogate = 'edge-\ud800';
        const validation = validateControlFleetRunReportCollection([
            report('run-lone-surrogate', 1_000, [
                agent('agent-lone-surrogate', {
                    region: loneSurrogate,
                    provider: 'provider'
                }, 'passed')
            ])
        ]);

        expect(validation.ok).toBe(true);
        expect(() =>
            createFleetReportAnalysisCollection({
                reports: validation.reports
            })
        ).not.toThrow();
        expect(deriveFleetReportRegionRows(validation.reports)[0]?.region)
            .toBe(loneSurrogate);
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
                    commands: { count: 0 }
                },
                regions: [],
                failureSignatures: []
            }
        } satisfies ControlFleetReportsResponse;

        expect(deriveFleetReportDisplaySummary([], response)).toEqual({
            runs: 2,
            agents: 5,
            regions: 3,
            passRate: 0.75,
            failureGroups: 4,
            p95DurationMs: 900,
            stale: 1
        });
    });

    it('builds a bounded composed model with exact linear indexing work', () => {
        const reports = Array.from({ length: 4 }, (_, runIndex) =>
            report(
                `run-${runIndex}`,
                4_000 - runIndex,
                Array.from({ length: 6 }, (_, agentIndex) =>
                    agent(
                        `agent-${agentIndex}`,
                        { region: `region-${agentIndex % 2}`, provider: 'p' },
                        agentIndex % 2 === 0 ? 'passed' : 'failed'
                    )),
                {
                    failures: [failure(`sig-${runIndex}`, 1)],
                    recipeIds: [`recipe-${runIndex}`],
                    runDurationMs: 100 + runIndex
                }
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
                agentDetailRuns: 2
            }
        });

        expect(analysis.heatmap).toMatchObject({
            totalAgentRows: 6,
            omittedAgentRows: 2,
            totalRunColumns: 4,
            omittedRunColumns: 1
        });
        expect(analysis.heatmap.rows).toHaveLength(4);
        expect(analysis.heatmap.runs).toHaveLength(3);
        expect(analysis.regions).toMatchObject({ total: 2, omitted: 1 });
        expect(analysis.failures).toMatchObject({ total: 4, omitted: 2 });
        expect(analysis.selectedAgent).toMatchObject({
            totalRuns: 4,
            omittedRuns: 2
        });
        expect(analysis.work).toEqual({
            reportVisits: 4,
            outcomeVisits: 24,
            indexInserts: 24,
            cellLookups: 12,
            failureSignatureVisits: 4
        });
        expect(JSON.stringify(reports)).toBe(before);
    });

    it('preserves public composed-analysis limits above UI window defaults', () => {
        const analysis = deriveFleetReportAnalysis({
            reports: traversalReports(),
            selectedAgentId: 'agent-00',
            limits: {
                heatmapAgentRows: 64,
                heatmapRunColumns: 16,
                regionRows: 48,
                failureRows: 40,
                timingGroups: 40,
                missingLabelAgentIds: 64,
                agentDetailRuns: 24
            }
        });

        expect(analysis.heatmap.rows).toHaveLength(64);
        expect(analysis.heatmap.runs).toHaveLength(16);
        expect(analysis.regions.items).toHaveLength(48);
        expect(analysis.failures.items).toHaveLength(40);
        expect(analysis.regionTiming.items).toHaveLength(40);
        expect(analysis.recipeTiming.items).toHaveLength(40);
        expect(analysis.missingLabelAgentIds.items).toHaveLength(64);
        expect(analysis.selectedAgent?.runs).toHaveLength(24);
    });
});
