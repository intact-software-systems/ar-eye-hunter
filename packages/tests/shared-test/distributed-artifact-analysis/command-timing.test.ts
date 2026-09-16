import { describe, expect, it } from 'vitest';

import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../../../shared-test/rallar-bb-test/control-snapshots.ts';
import {
    computeDistributedRunArtifactAnalysis,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { computeDistributedRunSnapshotPerformance } from '../../../shared-test/rallar-bb-test/distributed-run-performance/compute-distributed-run-performance.ts';
import {
    createControlRunSnapshot,
    createDistributedRunSnapshot,
    createQueuedCommandSnapshot,
    createResultEnvelope,
    HEALTH_RECIPE,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

function analyzedRun(files: DistributedRunArtifactFiles): DistributedRunAnalysis {
    const analyzed = computeDistributedRunArtifactAnalysis({ files, generatedAtEpochMs: 123 });
    if (analyzed.right?.variant !== 'distributed-run') {
        throw new Error(`Expected a distributed run analysis, got ${JSON.stringify(analyzed.left ?? analyzed.right)}`);
    }
    return analyzed.right.analysis;
}

function fleetCounterRunFiles(files: DistributedRunArtifactFiles): DistributedRunArtifactFiles {
    return toDistributedRunArtifactFiles({
        distributedRun: createDistributedRunSnapshot({
            distributedRunId: 'dist-fleet-counters',
            controlRunId: 'run-fleet-counters',
            state: 'passed',
            agentIds: ['controller-01']
        }),
        controlRun: createControlRunSnapshot({ runId: 'run-fleet-counters', agents: [{ agentId: 'controller-01' }] }),
        files
    });
}

describe('distributed run artifact command timing', () => {
    it('keeps 200,000 timing and receiver-delivery values within exact extrema', () => {
        const sampleCount = 200_000;
        const results = Array.from({ length: sampleCount }, (_, index) => ({
            kind: 'result' as const,
            protocolVersion: 1 as const,
            runId: 'run-large-performance',
            agentId: 'agent-large',
            commandId: `command-${index}`,
            ok: true,
            result: {
                commandId: `command-${index}`,
                kind: 'stats' as const,
                status: 'ok' as const,
                ok: true,
                startedAtEpochMs: 0,
                endedAtEpochMs: index + 1,
                durationMs: index + 1,
                value: {
                    counters: { messages: index },
                    metadata: {
                        receiverDelivery: {
                            expectedInboundMessages: index + 1,
                            minExpectedInboundMessages: 0,
                            minReceiveRatio: 0
                        }
                    }
                }
            }
        }));
        const performance = computeDistributedRunSnapshotPerformance({
            distributedRun: {
                distributedRunId: 'dist-large-performance',
                controlRunId: 'run-large-performance',
                manifest: {
                    distributedRunId: 'dist-large-performance',
                    controlRunId: 'run-large-performance',
                    group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'bb-group' },
                    recipes: [],
                    targetPolicy: { mode: 'selected-agents', agentIds: ['agent-large'] }
                },
                state: 'passed',
                createdAtEpochMs: 0,
                updatedAtEpochMs: 1,
                targetAgentIds: ['agent-large'],
                commandLinks: [],
                rollup: {
                    state: 'passed',
                    ok: true,
                    summary: {
                        participants: 1,
                        requiredParticipants: 1,
                        readyParticipants: 1,
                        passedParticipants: 1,
                        failedParticipants: 0,
                        recipes: 0,
                        requiredRecipes: 0,
                        passedRecipes: 0,
                        failedRecipes: 0,
                        groupAssertions: 0,
                        passedGroupAssertions: 0,
                        failedGroupAssertions: 0,
                        blockingFailures: 0
                    },
                    failures: []
                }
            } satisfies ControlDistributedRunSnapshot,
            controlRun: {
                runId: 'run-large-performance',
                createdAtEpochMs: 0,
                updatedAtEpochMs: 1,
                agents: [],
                commands: [],
                results,
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            } satisfies ControlRunSnapshot
        });

        expect(performance.commandTiming).toMatchObject({
            count: sampleCount,
            minMs: 1,
            p50Ms: 100_000,
            p95Ms: 190_000,
            p99Ms: 198_000,
            maxMs: sampleCount,
            averageMs: 100_000.5
        });
        expect(performance.slowestAgents).toEqual([{
            agentId: 'agent-large',
            commandCount: sampleCount,
            averageMs: 100_000.5,
            maxMs: sampleCount
        }]);
        expect(performance.receiverDelivery).toMatchObject({
            sampleCount,
            expectedInboundMessages: 1,
            minExpectedInboundMessages: 0,
            minReceiveRatio: 0,
            minReceivedMessages: 0,
            medianReceivedMessages: 99_999,
            p95ReceivedMessages: 189_999,
            maxReceivedMessages: sampleCount - 1,
            minDeliveryRatio: 0,
            medianDeliveryRatio: 1,
            p95DeliveryRatio: 1
        });
    }, 60_000);

    it('creates performance analysis for passed runs', () => {
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-passed',
                controlRunId: 'run-passed',
                state: 'passed',
                agentIds: ['controller-01', 'controller-02', 'controller-03'],
                startedAtEpochMs: 2_000,
                completedAtEpochMs: 8_000
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-passed',
                agents: [
                    { agentId: 'controller-01', receivedEventCount: 4 },
                    { agentId: 'controller-02', receivedEventCount: 5 },
                    { agentId: 'controller-03', receivedEventCount: 6 }
                ],
                commands: [
                    createQueuedCommandSnapshot({
                        runId: 'run-passed',
                        agentId: 'controller-01',
                        commandId: 'stage-1',
                        queuedAtEpochMs: 2_100,
                        dispatchedAtEpochMs: 2_150,
                        completedAtEpochMs: 2_500
                    }),
                    createQueuedCommandSnapshot({
                        runId: 'run-passed',
                        agentId: 'controller-01',
                        commandId: 'start-1',
                        command: { kind: 'recipe.run', recipe: HEALTH_RECIPE },
                        queuedAtEpochMs: 3_000,
                        dispatchedAtEpochMs: 3_100,
                        completedAtEpochMs: 5_000
                    })
                ]
            }),
            files: {
                'results.jsonl': '',
                'events.jsonl': JSON.stringify({
                    kind: 'rtc-diagnostic',
                    status: 'diagnostic',
                    transport: 'realtime',
                    agentId: 'controller-01',
                    value: {
                        severity: 'info',
                        message: 'RTC send completed.'
                    }
                }),
                'failures.json': JSON.stringify({ failures: [] }),
                'fleet-report.json': JSON.stringify({
                    distributedRunId: 'dist-passed',
                    state: 'passed',
                    ok: true,
                    summary: {
                        agents: 3,
                        regions: 1,
                        passed: 3,
                        failed: 0,
                        missing: 0,
                        flaky: 0,
                        stale: 0,
                        passRate: 1,
                        failureGroups: 0
                    },
                    failureSignatures: [],
                    timing: {
                        run: { count: 1, p50Ms: 6_000, p95Ms: 6_000, maxMs: 6_000 },
                        commands: { count: 2, p50Ms: 400, p95Ms: 1_900, maxMs: 1_900 }
                    }
                })
            }
        }));

        expect(analysis.ok).toBe(true);
        expect(analysis.status).toBe('passed');
        expect(analysis.performance.runDurationMs).toBe(6_000);
        expect(analysis.performance.agentCount).toBe(3);
        expect(analysis.performance.commandTiming.minMs).toBe(350);
        expect(analysis.performance.commandTiming.averageMs).toBe(1_125);
        expect(analysis.performance.commandTiming.p50Ms).toBe(350);
        expect(analysis.performance.commandTiming.p95Ms).toBe(1_900);
        expect(analysis.performance.commandTiming.p99Ms).toBe(1_900);
        expect(analysis.performance.commandTiming.spreadRatio).toBe(5.43);
        expect(analysis.performance.commandTiming.outlierCount).toBe(1);
        expect(analysis.performance.exportedEventCount).toBe(1);
        expect(analysis.performance.agentReportedEventCount).toBe(15);
        expect(analysis.performance.diagnosticCount).toBe(0);
        expect(analysis.performance.warningDiagnosticCount).toBe(0);
        expect(analysis.performance.errorDiagnosticCount).toBe(0);
        expect(analysis.performance.slowestAgents[0]).toMatchObject({
            agentId: 'controller-01',
            commandCount: 2,
            maxMs: 1_900
        });
        expect(analysis.performanceMarkdown).toContain('Pass rate: 100%');
        expect(analysis.performanceMarkdown).toContain('p99=1900ms');
        expect(analysis).not.toHaveProperty('fixProposalMarkdown');
    });

    it('leaves the fleet counters unknown when the artifacts hold no fleet report', () => {
        const withoutFleetReport = analyzedRun(fleetCounterRunFiles({}));
        const withFleetReport = analyzedRun(fleetCounterRunFiles({
            'fleet-report.json': JSON.stringify({ summary: { missing: 2, stale: 1, flaky: 0 } })
        }));

        expect(withoutFleetReport.performance.missingAgentCount).toBeUndefined();
        expect(withoutFleetReport.performance.staleAgentCount).toBeUndefined();
        expect(withoutFleetReport.performance.flakyAgentCount).toBeUndefined();
        expect(withoutFleetReport.performanceMarkdown).toContain('Missing agents: unknown');
        expect(withoutFleetReport.performanceMarkdown).toContain('Stale agents: unknown');
        expect(withoutFleetReport.performanceMarkdown).toContain('Flaky agents: unknown');
        expect(withoutFleetReport.performance.commandTiming).toEqual({ count: 0, outlierCount: 0 });
        expect(withFleetReport.performance).toMatchObject({
            missingAgentCount: 2,
            staleAgentCount: 1,
            flakyAgentCount: 0
        });
        expect(withFleetReport.performanceMarkdown).toContain('Missing agents: 2');
    });

    it('repeats a recorded command timing without inventing the counts it does not record', () => {
        const withoutCount = analyzedRun(fleetCounterRunFiles({
            'fleet-report.json': JSON.stringify({ timing: { commands: { p50Ms: 60, p95Ms: 70 } } })
        }));
        const withCount = analyzedRun(fleetCounterRunFiles({
            'fleet-report.json': JSON.stringify({ timing: { commands: { count: 2, p50Ms: 60, p95Ms: 70 } } })
        }));

        expect(withoutCount.performance.commandTiming).toEqual({ p50Ms: 60, p95Ms: 70, spreadRatio: 1.17 });
        expect(withoutCount.performanceMarkdown).toContain('Command timing: count=unknown,');
        expect(withoutCount.performanceMarkdown).toContain('outliers=unknown');
        expect(withCount.performance.commandTiming).toEqual({ count: 2, p50Ms: 60, p95Ms: 70, spreadRatio: 1.17 });
    });

    it('keeps command timing metrics on one linked distributed-command sample set', () => {
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-linked-timing',
                controlRunId: 'run-linked-timing',
                state: 'passed',
                agentIds: ['controller-01'],
                startedAtEpochMs: 1_000,
                completedAtEpochMs: 3_000,
                commandLinks: [
                    { phase: 'stage', agentId: 'controller-01', commandId: 'stage-1', queuedAtEpochMs: 1_050 },
                    { phase: 'start', agentId: 'controller-01', commandId: 'start-1', queuedAtEpochMs: 1_750 }
                ]
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-linked-timing',
                agents: [{ agentId: 'controller-01' }],
                commands: [
                    createQueuedCommandSnapshot({
                        runId: 'run-linked-timing',
                        agentId: 'controller-01',
                        commandId: 'stage-1',
                        command: { kind: 'recipe.load', recipe: HEALTH_RECIPE },
                        queuedAtEpochMs: 1_050,
                        dispatchedAtEpochMs: 1_100,
                        completedAtEpochMs: 1_600
                    }),
                    createQueuedCommandSnapshot({
                        runId: 'run-linked-timing',
                        agentId: 'controller-01',
                        commandId: 'start-1',
                        command: { kind: 'recipe.run', recipe: HEALTH_RECIPE },
                        queuedAtEpochMs: 1_750,
                        dispatchedAtEpochMs: 1_800,
                        completedAtEpochMs: 2_800
                    })
                ],
                results: [
                    createResultEnvelope({
                        runId: 'run-linked-timing',
                        agentId: 'controller-01',
                        commandId: 'reset-control-1',
                        kind: 'reset',
                        ok: true,
                        startedAtEpochMs: 0,
                        durationMs: 10_000
                    })
                ]
            }),
            files: {
                'events.jsonl': '',
                'fleet-report.json': JSON.stringify({
                    distributedRunId: 'dist-linked-timing',
                    state: 'passed',
                    ok: true,
                    summary: {
                        agents: 1,
                        regions: 1,
                        passed: 1,
                        failed: 0,
                        missing: 0,
                        flaky: 0,
                        stale: 0,
                        passRate: 1,
                        failureGroups: 0
                    },
                    timing: {
                        commands: { count: 2, minMs: 50, p50Ms: 60, p95Ms: 70, maxMs: 70 }
                    }
                })
            }
        }));

        expect(analysis.performance.commandTiming).toMatchObject({
            count: 2,
            minMs: 500,
            p50Ms: 500,
            p95Ms: 1_000,
            p99Ms: 1_000,
            maxMs: 1_000,
            averageMs: 750,
            spreadRatio: 2,
            outlierCount: 1
        });
        expect(analysis.performance.commandTiming.p99Ms).toBeLessThanOrEqual(
            analysis.performance.commandTiming.maxMs ?? 0
        );
        expect(analysis.performance.commandTiming.outlierCount).toBeLessThanOrEqual(
            analysis.performance.commandTiming.count ?? 0
        );
        expect(analysis.performance.slowestAgents).toEqual([
            {
                agentId: 'controller-01',
                commandCount: 2,
                averageMs: 750,
                maxMs: 1_000
            }
        ]);
    });

    it('uses control result durations when queued command snapshots carry no dispatch or completion times', () => {
        const commandIds = ['cmd-a', 'cmd-b', 'cmd-c'];
        const agentIdByCommandId: Readonly<Record<string, string>> = {
            'cmd-a': 'agent-a',
            'cmd-b': 'agent-b',
            'cmd-c': 'agent-b'
        };
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-result-timing',
                controlRunId: 'run-result-timing',
                state: 'passed',
                agentIds: ['agent-a', 'agent-b'],
                startedAtEpochMs: 1_000,
                completedAtEpochMs: 2_000,
                commandLinks: commandIds.map((commandId, index) => ({
                    phase: 'start' as const,
                    agentId: agentIdByCommandId[commandId] ?? 'agent-a',
                    commandId,
                    queuedAtEpochMs: 1_010 + index * 10
                }))
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-result-timing',
                agents: [
                    { agentId: 'agent-a', receivedEventCount: 1 },
                    { agentId: 'agent-b', receivedEventCount: 1 }
                ],
                commands: commandIds.map((commandId, index) =>
                    createQueuedCommandSnapshot({
                        runId: 'run-result-timing',
                        agentId: agentIdByCommandId[commandId] ?? 'agent-a',
                        commandId,
                        queuedAtEpochMs: 1_010 + index * 10
                    })
                ),
                results: [
                    { commandId: 'cmd-a', durationMs: 20 },
                    { commandId: 'cmd-b', durationMs: 40 },
                    { commandId: 'cmd-c', durationMs: 400 }
                ].map((sample) =>
                    createResultEnvelope({
                        runId: 'run-result-timing',
                        agentId: agentIdByCommandId[sample.commandId] ?? 'agent-a',
                        commandId: sample.commandId,
                        kind: 'health',
                        ok: true,
                        startedAtEpochMs: 1_100,
                        durationMs: sample.durationMs
                    })
                )
            })
        }));

        expect(analysis.performance.commandTiming).toMatchObject({
            count: 3,
            minMs: 20,
            p50Ms: 40,
            p95Ms: 400,
            p99Ms: 400,
            maxMs: 400
        });
        expect(analysis.performance.slowestAgents[0]).toMatchObject({
            agentId: 'agent-b',
            commandCount: 2,
            maxMs: 400,
            averageMs: 220
        });
    });
});
