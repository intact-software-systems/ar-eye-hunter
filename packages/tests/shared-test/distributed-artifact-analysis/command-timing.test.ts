import { describe, expect, it } from 'vitest';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../../../shared-test/rallar-bb-test/control-snapshots.ts';
import {
    analyzeDistributedRunArtifactFiles,
    deriveDistributedRunSnapshotPerformance
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

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
        const performance = deriveDistributedRunSnapshotPerformance({
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
            } satisfies ControlRunSnapshot,
            artifactResults: [],
            artifactEvents: []
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
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-passed',
                    controlRunId: 'run-passed',
                    state: 'passed',
                    startedAtEpochMs: 2_000,
                    completedAtEpochMs: 8_000,
                    rollup: {
                        ok: true,
                        summary: {
                            participants: 3,
                            failedParticipants: 0,
                            blockingFailures: 0
                        }
                    },
                    manifest: {
                        group: {
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            groupId: 'bb-group'
                        }
                    }
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-passed',
                    agents: [
                        { agentId: 'controller-01', connected: true, reconnectCount: 0, receivedEventCount: 4 },
                        { agentId: 'controller-02', connected: true, reconnectCount: 0, receivedEventCount: 5 },
                        { agentId: 'controller-03', connected: true, reconnectCount: 0, receivedEventCount: 6 }
                    ],
                    commands: [
                        {
                            envelope: {
                                agentId: 'controller-01',
                                commandId: 'stage-1',
                                command: { kind: 'health' }
                            },
                            queuedAtEpochMs: 2_100,
                            dispatchedAtEpochMs: 2_150,
                            completedAtEpochMs: 2_500
                        },
                        {
                            envelope: {
                                agentId: 'controller-01',
                                commandId: 'start-1',
                                command: { kind: 'recipe.run' }
                            },
                            queuedAtEpochMs: 3_000,
                            dispatchedAtEpochMs: 3_100,
                            completedAtEpochMs: 5_000
                        }
                    ],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: []
                }),
                'results.jsonl': '',
                'events.jsonl': [
                    JSON.stringify({
                        kind: 'rtc-diagnostic',
                        status: 'diagnostic',
                        transport: 'realtime',
                        agentId: 'controller-01',
                        value: {
                            severity: 'info',
                            message: 'RTC send completed.'
                        }
                    })
                ].join('\n'),
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
        });

        expect(analysis.ok).toBe(true);
        expect(analysis.status).toBe('passed');
        expect(analysis.performance?.runDurationMs).toBe(6_000);
        expect(analysis.performance?.agentCount).toBe(3);
        expect(analysis.performance?.commandTiming.minMs).toBe(350);
        expect(analysis.performance?.commandTiming.averageMs).toBe(1_125);
        expect(analysis.performance?.commandTiming.p50Ms).toBe(350);
        expect(analysis.performance?.commandTiming.p95Ms).toBe(1_900);
        expect(analysis.performance?.commandTiming.p99Ms).toBe(1_900);
        expect(analysis.performance?.commandTiming.spreadRatio).toBe(5.43);
        expect(analysis.performance?.commandTiming.outlierCount).toBe(1);
        expect(analysis.performance?.exportedEventCount).toBe(1);
        expect(analysis.performance?.agentReportedEventCount).toBe(15);
        expect(analysis.performance?.diagnosticCount).toBe(0);
        expect(analysis.performance?.warningDiagnosticCount).toBe(0);
        expect(analysis.performance?.errorDiagnosticCount).toBe(0);
        expect(analysis.performance?.slowestAgents[0]).toMatchObject({
            agentId: 'controller-01',
            commandCount: 2,
            maxMs: 1_900
        });
        expect(analysis.performanceMarkdown).toContain('Pass rate: 100%');
        expect(analysis.performanceMarkdown).toContain('p99=1900ms');
        expect(analysis.fixProposalMarkdown).toBeUndefined();
    });

    it('keeps command timing metrics on one linked distributed-command sample set', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-linked-timing',
                    controlRunId: 'run-linked-timing',
                    state: 'passed',
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 3_000,
                    commandLinks: [
                        { phase: 'stage', agentId: 'controller-01', commandId: 'stage-1' },
                        { phase: 'start', agentId: 'controller-01', commandId: 'start-1' }
                    ],
                    rollup: {
                        ok: true,
                        summary: {
                            participants: 1,
                            passedParticipants: 1,
                            failedParticipants: 0,
                            blockingFailures: 0
                        }
                    },
                    manifest: {
                        group: {
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            groupId: 'bb-group'
                        }
                    }
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-linked-timing',
                    agents: [
                        { agentId: 'controller-01', connected: true, reconnectCount: 0, receivedEventCount: 0 }
                    ],
                    commands: [
                        {
                            envelope: {
                                agentId: 'controller-01',
                                commandId: 'stage-1',
                                command: { kind: 'recipe.load' }
                            },
                            dispatchedAtEpochMs: 1_100,
                            completedAtEpochMs: 1_600
                        },
                        {
                            envelope: {
                                agentId: 'controller-01',
                                commandId: 'start-1',
                                command: { kind: 'recipe.run' }
                            },
                            dispatchedAtEpochMs: 1_800,
                            completedAtEpochMs: 2_800
                        }
                    ],
                    results: [
                        {
                            agentId: 'controller-01',
                            commandId: 'reset-control-1',
                            ok: true,
                            result: { durationMs: 10_000 }
                        }
                    ],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: []
                }),
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
        });

        expect(analysis.performance?.commandTiming).toMatchObject({
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
        expect(analysis.performance?.commandTiming.p99Ms).toBeLessThanOrEqual(
            analysis.performance?.commandTiming.maxMs ?? 0
        );
        expect(analysis.performance?.commandTiming.outlierCount).toBeLessThanOrEqual(
            analysis.performance?.commandTiming.count ?? 0
        );
        expect(analysis.performance?.slowestAgents).toEqual([
            {
                agentId: 'controller-01',
                commandCount: 2,
                averageMs: 750,
                maxMs: 1_000
            }
        ]);
    });

    it('uses result JSONL durations for passed-run performance when command snapshots are bounded', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-result-timing',
                    controlRunId: 'run-result-timing',
                    state: 'passed',
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 2_000,
                    rollup: { ok: true, failures: [], summary: { blockingFailures: 0 } },
                    manifest: { recipes: [], group: { groupId: 'bb-group' } },
                    targetAgentIds: ['agent-a', 'agent-b'],
                    commandLinks: [
                        { phase: 'start', agentId: 'agent-a', commandId: 'cmd-a', queuedAtEpochMs: 1_010 },
                        { phase: 'start', agentId: 'agent-b', commandId: 'cmd-b', queuedAtEpochMs: 1_020 },
                        { phase: 'start', agentId: 'agent-b', commandId: 'cmd-c', queuedAtEpochMs: 1_030 }
                    ]
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-result-timing',
                    agents: [
                        { agentId: 'agent-a', connected: true, reconnectCount: 0, receivedEventCount: 1 },
                        { agentId: 'agent-b', connected: true, reconnectCount: 0, receivedEventCount: 1 }
                    ],
                    commands: [
                        { envelope: { agentId: 'agent-a', commandId: 'cmd-a', command: { kind: 'health' } } },
                        { envelope: { agentId: 'agent-b', commandId: 'cmd-b', command: { kind: 'health' } } },
                        { envelope: { agentId: 'agent-b', commandId: 'cmd-c', command: { kind: 'health' } } }
                    ],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: []
                }),
                'results.jsonl': [
                    JSON.stringify({ agentId: 'agent-a', commandId: 'cmd-a', ok: true, result: { durationMs: 20 } }),
                    JSON.stringify({ agentId: 'agent-b', commandId: 'cmd-b', ok: true, result: { durationMs: 40 } }),
                    JSON.stringify({ agentId: 'agent-b', commandId: 'cmd-c', ok: true, result: { startedAtEpochMs: 1_100, endedAtEpochMs: 1_500 } })
                ].join('\n')
            }
        });

        expect(analysis.performance?.commandTiming).toMatchObject({
            count: 3,
            minMs: 20,
            p50Ms: 40,
            p95Ms: 400,
            p99Ms: 400,
            maxMs: 400
        });
        expect(analysis.performance?.slowestAgents[0]).toMatchObject({
            agentId: 'agent-b',
            commandCount: 2,
            maxMs: 400,
            averageMs: 220
        });
    });
});
