import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunArtifactFiles,
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    analyzeDistributedRunArtifactDirectory,
} from '../../../apps/rallar-black-box/scripts/analyze-distributed-run-artifacts.ts';
import { deriveDistributedRunMonitor } from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';

describe('Hetzner distributed run artifact analysis', () => {
    it('uses JSONL fallback evidence consistently for CLI analysis and SPA snapshots', () => {
        const files: DistributedRunArtifactFiles = {
            'distributed-run.json': JSON.stringify({
                distributedRunId: 'dist-jsonl-only',
                controlRunId: 'run-jsonl-only',
                state: 'failed',
                startedAtEpochMs: 1_000,
                completedAtEpochMs: 2_000,
                targetAgentIds: ['agent-a'],
                commandLinks: [],
                rollup: { ok: false, failures: [], summary: { blockingFailures: 1 } },
                manifest: {
                    recipes: [{ recipeId: 'rtc-smoke', recipe: { recipeId: 'rtc-smoke', commands: [] } }],
                    group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'bb-group' },
                },
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-jsonl-only',
                agents: [{ agentId: 'agent-a', connected: true, reconnectCount: 0, receivedEventCount: 1 }],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
            }),
            'results.jsonl': JSON.stringify({
                resultKey: 'agent-a:send-rtc',
                status: 'FAILURE',
                agentId: 'agent-a',
                action: 'rtc.send',
                actual: {
                    code: 'RTC_NO_ROUTE',
                    message: 'No route to peer.',
                },
            }),
            'events.jsonl': JSON.stringify({
                kind: 'rtc-diagnostic',
                transport: 'realtime',
                agentId: 'agent-a',
                value: {
                    severity: 'error',
                    message: 'No RTC route to receiver.',
                },
            }),
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });
        const snapshots = distributedArtifactSnapshotsFromFiles(files, 123);

        expect(analysis.failure).toMatchObject({
            commandId: 'send-rtc',
            affectedAgents: ['agent-a'],
        });
        expect(analysis.spa?.report.firstFailure).toMatchObject({
            commandId: 'send-rtc',
            agentId: 'agent-a',
        });
        expect(snapshots.distributedRun.commandLinks.map(link => link.commandId)).toEqual(['send-rtc']);
        expect(snapshots.controlRun.results.map(result => [result.commandId, result.ok])).toEqual([
            ['send-rtc', false],
        ]);
        expect(snapshots.controlRun.events.map(event => [event.kind, event.agentId])).toEqual([
            ['diagnostic', 'agent-a'],
        ]);
    });

    it('uses runner summary and manifest fallbacks when the distributed-run snapshot is empty', () => {
        const files: DistributedRunArtifactFiles = {
            'distributed-run.json': '',
            'runner-summary.json': JSON.stringify({
                distributedRunId: 'dist-empty-snapshot',
                controlRunId: 'run-empty-snapshot',
                state: 'timed-out',
                ok: false,
            }),
            'manifest.json': JSON.stringify({
                schemaVersion: 1,
                distributedRunId: 'dist-empty-snapshot',
                controlRunId: 'run-empty-snapshot',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'hetzner-headless-room',
                },
                recipes: [],
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-empty-snapshot',
                agents: [{ agentId: 'controller-01', connected: true }],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
            }),
            'results.jsonl': JSON.stringify({
                agentId: 'controller-01',
                commandId: 'rtc-realtime-position-stream',
                action: 'rtc.stream',
                status: 'FAILURE',
                result: {
                    durationMs: 1_350,
                    plannedFrames: 100,
                    completedFrames: 82,
                    failedFrames: 18,
                    droppedFrames: 18,
                    observations: [{ durationMs: 1_350, dropped: false }],
                },
                error: {
                    code: 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED',
                    message: 'RTC stream had failed frame sends.',
                },
            }),
            'events.jsonl': JSON.stringify({
                kind: 'diagnostic',
                topic: 'rallar.bb.rtc.stream_failed',
                agentId: 'controller-01',
                commandId: 'rtc-realtime-position-stream',
                payload: {
                    severity: 'error',
                    message: 'RTC stream had failed frame sends.',
                },
            }),
            'failures.json': JSON.stringify({
                failures: [{
                    agentId: 'controller-01',
                    commandId: 'rtc-realtime-position-stream',
                    error: {
                        code: 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED',
                        message: 'RTC stream had failed frame sends.',
                    },
                }],
            }),
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });
        const snapshots = distributedArtifactSnapshotsFromFiles(files, 123);
        const monitor = deriveDistributedRunMonitor({
            distributedRun: snapshots.distributedRun,
            controlRun: snapshots.controlRun,
            artifactBundle: snapshots.artifactBundle,
        });

        expect(analysis).toMatchObject({
            distributedRunId: 'dist-empty-snapshot',
            controlRunId: 'run-empty-snapshot',
            status: 'timed-out',
            ok: false,
            failure: {
                commandId: 'rtc-realtime-position-stream',
                evidenceFile: 'results.jsonl',
            },
        });
        expect(analysis.parseWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                fileName: 'distributed-run.json',
                message: expect.stringContaining('using runner-summary.json and manifest.json fallback'),
            }),
        ]));
        expect(analysis.performance?.streamTiming).toMatchObject({
            plannedFrames: 100,
            completedFrames: 82,
            droppedFrames: 18,
        });
        expect(monitor.artifact).toMatchObject({ status: 'invalid-json' });
        expect(snapshots.distributedRun.manifest.group).toMatchObject({
            groupId: 'hetzner-headless-room',
        });
    });

    it('uses failed control POST artifacts as failure evidence', () => {
        const files: DistributedRunArtifactFiles = {
            'distributed-run.json': '',
            'runner-summary.json': JSON.stringify({
                distributedRunId: 'dist-post-failure',
                controlRunId: 'run-post-failure',
                state: 'failed',
                ok: false,
            }),
            'manifest.json': JSON.stringify({
                schemaVersion: 1,
                distributedRunId: 'dist-post-failure',
                controlRunId: 'run-post-failure',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'hetzner-headless-room',
                },
                recipes: [],
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-post-failure',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
            }),
            'control-post-create-error.json': JSON.stringify({
                error: 'bad manifest',
                message: 'target policy rejected',
            }),
            'control-post-error-metadata.json': JSON.stringify({
                phase: 'create',
                method: 'POST',
                path: '/distributed-runs',
                httpStatus: '400',
                curlStatus: 0,
                exitStatus: 22,
                responseFile: 'control-post-create-error.json',
            }),
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });
        const bundle = distributedArtifactBundleFromFiles(files, 123);

        expect(analysis.failure).toMatchObject({
            category: 'control-api',
            title: 'Control API create request failed.',
            likelyCause: 'target policy rejected',
            evidenceFile: 'control-post-create-error.json',
        });
        expect(analysis.failure?.nextAction).toContain('POST /distributed-runs returned HTTP 400');
        expect(analysis.fixProposalMarkdown).toContain('Evidence: control-post-create-error.json');
        expect(bundle?.files).toMatchObject({
            'control-post-create-error.json': JSON.stringify({
                error: 'bad manifest',
                message: 'target policy rejected',
            }),
            'control-post-error-metadata.json': expect.any(String),
        });
    });

    it('uses control POST metadata as failure evidence when no response body was saved', () => {
        const files: DistributedRunArtifactFiles = {
            'distributed-run.json': '',
            'runner-summary.json': JSON.stringify({
                distributedRunId: 'dist-post-network-failure',
                controlRunId: 'run-post-network-failure',
                state: 'failed',
                ok: false,
            }),
            'manifest.json': JSON.stringify({
                schemaVersion: 1,
                distributedRunId: 'dist-post-network-failure',
                controlRunId: 'run-post-network-failure',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'hetzner-headless-room',
                },
                recipes: [],
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-post-network-failure',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
            }),
            'control-post-error-metadata.json': JSON.stringify({
                phase: 'start',
                method: 'POST',
                path: '/distributed-runs/dist-post-network-failure/start',
                httpStatus: null,
                curlStatus: 7,
                exitStatus: 7,
                responseFile: null,
            }),
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });

        expect(analysis.failure).toMatchObject({
            category: 'control-api',
            title: 'Control API start request failed.',
            evidenceFile: 'control-post-error-metadata.json',
        });
        expect(analysis.failure?.likelyCause).toContain('curl 7');
        expect(analysis.failure?.likelyCause).toContain('exit 7');
        expect(analysis.failure?.nextAction).toContain('POST /distributed-runs/dist-post-network-failure/start');
        expect(analysis.fixProposalMarkdown).toContain('Evidence: control-post-error-metadata.json');
    });

    it('creates a fix proposal from failed fleet signatures and command evidence', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-failed',
                    controlRunId: 'run-failed',
                    state: 'failed',
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 4_000,
                    rollup: {
                        ok: false,
                        summary: {
                            participants: 2,
                            failedParticipants: 1,
                            blockingFailures: 1,
                        },
                    },
                    manifest: {
                        group: {
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            groupId: 'bb-group',
                        },
                    },
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-failed',
                    agents: [
                        {
                            agentId: 'controller-01',
                            connected: true,
                            reconnectCount: 0,
                            receivedEventCount: 2,
                        },
                        {
                            agentId: 'controller-02',
                            connected: true,
                            reconnectCount: 1,
                            receivedEventCount: 3,
                        },
                    ],
                    commands: [
                        {
                            envelope: {
                                agentId: 'controller-02',
                                commandId: 'send-rtc',
                                command: {
                                    kind: 'rtc.send',
                                    transport: 'realtime',
                                },
                            },
                            queuedAtEpochMs: 1_100,
                            dispatchedAtEpochMs: 1_150,
                            completedAtEpochMs: 2_400,
                        },
                    ],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'results.jsonl': [
                    JSON.stringify({
                        resultKey: 'controller-02:send-rtc',
                        status: 'FAILURE',
                        transport: 'realtime',
                        action: 'rtc.send',
                        agentId: 'controller-02',
                        commandId: 'send-rtc',
                        actual: {
                            code: 'RTC_NO_ROUTE',
                            message: 'No route to peer.',
                        },
                    }),
                ].join('\n'),
                'events.jsonl': [
                    JSON.stringify({
                        kind: 'rtc-diagnostic',
                        status: 'diagnostic',
                        transport: 'realtime',
                        agentId: 'controller-02',
                        commandId: 'send-rtc',
                        value: {
                            diagnosticTypeId: 'rallar.browser.rtc.no_route',
                            severity: 'error',
                            message: 'No RTC route to receiver.',
                        },
                    }),
                ].join('\n'),
                'failures.json': JSON.stringify({
                    failures: [
                        {
                            agentId: 'controller-02',
                            commandId: 'send-rtc',
                            error: {
                                code: 'RTC_NO_ROUTE',
                                message: 'No route to peer.',
                            },
                        },
                    ],
                }),
                'fleet-report.json': JSON.stringify({
                    distributedRunId: 'dist-failed',
                    state: 'failed',
                    ok: false,
                    summary: {
                        agents: 2,
                        regions: 1,
                        passed: 1,
                        failed: 1,
                        missing: 0,
                        flaky: 0,
                        stale: 0,
                        passRate: 0.5,
                        failureGroups: 1,
                    },
                    failureSignatures: [
                        {
                            signatureId: 'diagnostic-rtc-no-route',
                            category: 'diagnostic',
                            title: 'RTC route failure',
                            normalizedMessage: 'no rtc route to receiver',
                            transport: 'realtime',
                            count: 1,
                            affectedAgents: ['controller-02'],
                            affectedRegions: ['eu-north'],
                            affectedRuns: ['dist-failed'],
                            likelyCause: 'Runtime transport diagnostics correlated with the distributed run.',
                            nextAction: 'Inspect RTC lane, peer, group, and topic evidence for affected agents.',
                        },
                    ],
                    timing: {
                        run: { count: 1, p50Ms: 3_000, p95Ms: 3_000, maxMs: 3_000 },
                        commands: { count: 1, p50Ms: 1_250, p95Ms: 1_250, maxMs: 1_250 },
                    },
                }),
            },
        });

        expect(analysis.ok).toBe(false);
        expect(analysis.status).toBe('failed');
        expect(analysis.failure?.category).toBe('diagnostic');
        expect(analysis.failure?.affectedAgents).toEqual(['controller-02']);
        expect(analysis.failure?.minimalFixArea).toBe('RTC/TURN');
        expect(analysis.failure?.verificationCommand).toContain('live-rtc-3');
        expect(analysis.fixProposalMarkdown).toContain('RTC route failure');
        expect(analysis.fixProposalMarkdown).toContain('send-rtc');
        expect(analysis.summaryMarkdown).toContain('dist-failed');
        expect(analysis.spa?.verdict.title).toBe('Outcome failed');
        expect(analysis.spa?.report.nextActions[0]?.category).toBe('command');
    });

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
                            blockingFailures: 0,
                        },
                    },
                    manifest: {
                        group: {
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            groupId: 'bb-group',
                        },
                    },
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-passed',
                    agents: [
                        { agentId: 'controller-01', connected: true, reconnectCount: 0, receivedEventCount: 4 },
                        { agentId: 'controller-02', connected: true, reconnectCount: 0, receivedEventCount: 5 },
                        { agentId: 'controller-03', connected: true, reconnectCount: 0, receivedEventCount: 6 },
                    ],
                    commands: [
                        {
                            envelope: {
                                agentId: 'controller-01',
                                commandId: 'stage-1',
                                command: { kind: 'health' },
                            },
                            queuedAtEpochMs: 2_100,
                            dispatchedAtEpochMs: 2_150,
                            completedAtEpochMs: 2_500,
                        },
                        {
                            envelope: {
                                agentId: 'controller-01',
                                commandId: 'start-1',
                                command: { kind: 'recipe.run' },
                            },
                            queuedAtEpochMs: 3_000,
                            dispatchedAtEpochMs: 3_100,
                            completedAtEpochMs: 5_000,
                        },
                    ],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
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
                            message: 'RTC send completed.',
                        },
                    }),
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
                        failureGroups: 0,
                    },
                    failureSignatures: [],
                    timing: {
                        run: { count: 1, p50Ms: 6_000, p95Ms: 6_000, maxMs: 6_000 },
                        commands: { count: 2, p50Ms: 400, p95Ms: 1_900, maxMs: 1_900 },
                    },
                }),
            },
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
            maxMs: 1_900,
        });
        expect(analysis.performanceMarkdown).toContain('Pass rate: 100%');
        expect(analysis.performanceMarkdown).toContain('p99=1900ms');
        expect(analysis.fixProposalMarkdown).toBeUndefined();
    });

    it('derives stream performance from rtc.stream JSONL result summaries', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-stream-passed',
                    controlRunId: 'run-stream-passed',
                    state: 'passed',
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 7_000,
                    commandLinks: [
                        { phase: 'start', agentId: 'controller-01', commandId: 'stream-a' },
                        { phase: 'start', agentId: 'controller-02', commandId: 'stream-b' },
                    ],
                    rollup: { ok: true, failures: [], summary: { blockingFailures: 0 } },
                    manifest: { recipes: [], group: { groupId: 'bb-group' } },
                    targetAgentIds: ['controller-01', 'controller-02'],
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-stream-passed',
                    agents: [
                        { agentId: 'controller-01', connected: true, reconnectCount: 0, receivedEventCount: 30 },
                        { agentId: 'controller-02', connected: true, reconnectCount: 0, receivedEventCount: 35 },
                    ],
                    commands: [],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'results.jsonl': [
                    JSON.stringify({
                        agentId: 'controller-01',
                        commandId: 'stream-a',
                        action: 'rtc.stream',
                        status: 'OK',
                        ok: true,
                        result: {
                            commandId: 'rtc-realtime-position-stream',
                            transport: 'realtime',
                            plannedFrames: 3,
                            scheduledFrames: 3,
                            attemptedFrames: 3,
                            completedFrames: 3,
                            failedFrames: 0,
                            droppedFrames: 0,
                            backpressureCount: 0,
                            requestedRateHz: 20,
                            achievedScheduleHz: 20,
                            achievedCompletionHz: 20,
                            duration: { minMs: 10, p50Ms: 20, p95Ms: 30, p99Ms: 30, maxMs: 30, averageMs: 20 },
                            observations: [
                                { index: 0, iteration: 1, durationMs: 10, ok: true },
                                { index: 1, iteration: 2, durationMs: 20, ok: true },
                                { index: 2, iteration: 3, durationMs: 30, ok: true },
                            ],
                            thresholdFailures: [],
                        },
                    }),
                    JSON.stringify({
                        agentId: 'controller-02',
                        commandId: 'stream-b',
                        action: 'rtc.stream',
                        status: 'OK',
                        ok: true,
                        result: {
                            commandId: 'rtc-realtime-position-stream',
                            transport: 'realtime',
                            plannedFrames: 2,
                            scheduledFrames: 2,
                            attemptedFrames: 2,
                            completedFrames: 2,
                            failedFrames: 0,
                            droppedFrames: 0,
                            backpressureCount: 1,
                            requestedRateHz: 20,
                            achievedScheduleHz: 18,
                            achievedCompletionHz: 18,
                            duration: { minMs: 40, p50Ms: 40, p95Ms: 50, p99Ms: 50, maxMs: 50, averageMs: 45 },
                            observations: [
                                { index: 0, iteration: 1, durationMs: 40, ok: true, backpressured: true },
                                { index: 1, iteration: 2, durationMs: 50, ok: true },
                            ],
                            thresholdFailures: [],
                        },
                    }),
                ].join('\n'),
                'events.jsonl': '',
            },
        });

        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 2,
            plannedFrames: 5,
            scheduledFrames: 5,
            attemptedFrames: 5,
            completedFrames: 5,
            failedFrames: 0,
            droppedFrames: 0,
            backpressureCount: 1,
            sendSuccessRatio: 1,
            duration: {
                count: 5,
                minMs: 10,
                p50Ms: 30,
                p95Ms: 50,
                p99Ms: 50,
                maxMs: 50,
                averageMs: 30,
                outlierCount: 1,
            },
        });
        expect(analysis.performance?.streamTiming?.slowestAgents[0]).toMatchObject({
            agentId: 'controller-02',
            streamCount: 1,
            completedFrames: 2,
            maxMs: 50,
        });
        expect(analysis.performanceMarkdown).toContain('Stream timing: streams=2, frames=5/5');
        expect(analysis.performanceMarkdown).toContain('p99=50ms');
    });

    it('keeps failed rtc.stream result summaries available for performance analysis', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-stream-failed',
                    controlRunId: 'run-stream-failed',
                    state: 'failed',
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 8_000,
                    rollup: {
                        ok: false,
                        failures: [
                            {
                                kind: 'participant',
                                key: 'controller-01',
                                error: {
                                    code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                                    message: 'RTC stream did not satisfy configured thresholds.',
                                },
                            },
                        ],
                        summary: { blockingFailures: 1 },
                    },
                    manifest: { recipes: [], group: { groupId: 'bb-group' } },
                    targetAgentIds: ['controller-01'],
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-stream-failed',
                    agents: [{ agentId: 'controller-01', connected: true, reconnectCount: 1, receivedEventCount: 20 }],
                    commands: [],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'results.jsonl': [
                    JSON.stringify({
                        agentId: 'controller-01',
                        commandId: 'rtc-realtime-position-stream',
                        action: 'rtc.stream',
                        status: 'FAILURE',
                        ok: false,
                        actual: {
                            code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                            message: 'RTC stream did not satisfy configured thresholds.',
                            value: {
                                commandId: 'rtc-realtime-position-stream',
                                transport: 'realtime',
                                plannedFrames: 100,
                                scheduledFrames: 100,
                                attemptedFrames: 88,
                                completedFrames: 88,
                                failedFrames: 0,
                                droppedFrames: 12,
                                backpressureCount: 0,
                                requestedRateHz: 20,
                                achievedScheduleHz: 20,
                                achievedCompletionHz: 17.6,
                                duration: { minMs: 4, p50Ms: 8, p95Ms: 15, p99Ms: 18, maxMs: 18, averageMs: 9 },
                                observations: [
                                    { index: 0, iteration: 1, durationMs: 4, ok: true },
                                    { index: 1, iteration: 2, durationMs: 8, ok: true },
                                    { index: 2, iteration: 3, durationMs: 18, ok: true },
                                    { index: 3, iteration: 4, durationMs: 0, ok: false, dropped: true },
                                ],
                                thresholdFailures: [
                                    {
                                        name: 'maxDroppedFrames',
                                        category: 'delivery',
                                        threshold: 0,
                                        actual: 12,
                                    },
                                ],
                            },
                        },
                    }),
                ].join('\n'),
                'events.jsonl': '',
            },
        });

        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 100,
            scheduledFrames: 100,
            attemptedFrames: 88,
            completedFrames: 88,
            failedFrames: 0,
            droppedFrames: 12,
            sendSuccessRatio: 1,
            duration: {
                count: 3,
                minMs: 4,
                p50Ms: 8,
                p95Ms: 18,
                p99Ms: 18,
                maxMs: 18,
            },
        });
        expect(analysis.performanceMarkdown).toContain('Stream timing: streams=1, frames=88/100');
        expect(analysis.performanceMarkdown).toContain('dropped=12');
    });

    it('uses the latest stream event when result JSONL is bounded', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-stream-events',
                    controlRunId: 'run-stream-events',
                    state: 'passed',
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 7_000,
                    rollup: { ok: true, failures: [], summary: { blockingFailures: 0 } },
                    manifest: { recipes: [], group: { groupId: 'bb-group' } },
                    targetAgentIds: ['controller-01'],
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-stream-events',
                    agents: [{ agentId: 'controller-01', connected: true, reconnectCount: 0, receivedEventCount: 3 }],
                    commands: [],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'results.jsonl': '',
                'events.jsonl': [
                    JSON.stringify({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.stream_started',
                        severity: 'info',
                        agentId: 'controller-01',
                        commandId: 'rtc-realtime-position-stream',
                        payload: {
                            topic: 'rallar.bb.rtc.stream_started',
                            severity: 'info',
                            data: { plannedFrames: 100, scheduledFrames: 0, completedFrames: 0 },
                        },
                    }),
                    JSON.stringify({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.stream_progress',
                        severity: 'info',
                        agentId: 'controller-01',
                        commandId: 'rtc-realtime-position-stream',
                        payload: {
                            topic: 'rallar.bb.rtc.stream_progress',
                            severity: 'info',
                            data: { plannedFrames: 100, scheduledFrames: 80, attemptedFrames: 80, completedFrames: 80 },
                        },
                    }),
                    JSON.stringify({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.stream_completed',
                        severity: 'info',
                        agentId: 'controller-01',
                        commandId: 'rtc-realtime-position-stream',
                        payload: {
                            topic: 'rallar.bb.rtc.stream_completed',
                            severity: 'info',
                            data: {
                                plannedFrames: 100,
                                scheduledFrames: 100,
                                attemptedFrames: 100,
                                completedFrames: 100,
                                failedFrames: 0,
                                droppedFrames: 0,
                                duration: { p50Ms: 25, p95Ms: 40, p99Ms: 45, maxMs: 50 },
                            },
                        },
                    }),
                ].join('\n'),
            },
        });

        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 100,
            scheduledFrames: 100,
            attemptedFrames: 100,
            completedFrames: 100,
            duration: {
                p50Ms: 25,
                p95Ms: 40,
                p99Ms: 45,
                maxMs: 50,
            },
        });
    });

    it('uses stream progress evidence when timed-out runs have no failed result', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-stream-timeout',
                    controlRunId: 'run-stream-timeout',
                    state: 'timed-out',
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 61_000,
                    rollup: { ok: false, failures: [], summary: { blockingFailures: 1 } },
                    manifest: { recipes: [], group: { groupId: 'bb-group' } },
                    targetAgentIds: ['controller-01'],
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-stream-timeout',
                    agents: [{ agentId: 'controller-01', connected: true, reconnectCount: 0, receivedEventCount: 5 }],
                    commands: [],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'results.jsonl': '',
                'events.jsonl': [
                    JSON.stringify({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.stream_started',
                        severity: 'info',
                        agentId: 'controller-01',
                        commandId: 'rtc-realtime-position-stream',
                        payload: {
                            topic: 'rallar.bb.rtc.stream_started',
                            severity: 'info',
                            data: { plannedFrames: 100, scheduledFrames: 0, completedFrames: 0 },
                        },
                    }),
                    JSON.stringify({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.stream_progress',
                        severity: 'info',
                        agentId: 'controller-01',
                        commandId: 'rtc-realtime-position-stream',
                        payload: {
                            topic: 'rallar.bb.rtc.stream_progress',
                            severity: 'info',
                            data: {
                                plannedFrames: 100,
                                scheduledFrames: 100,
                                attemptedFrames: 100,
                                completedFrames: 98,
                                failedFrames: 0,
                                droppedFrames: 0,
                                inFlightFrames: 2,
                            },
                        },
                    }),
                ].join('\n'),
            },
        });

        expect(analysis.failure).toMatchObject({
            category: 'rtc-stream',
            title: 'RTC stream did not finish before the distributed run timed out.',
            likelyCause: 'RTC stream rtc-realtime-position-stream reached 98 of 100 completed frames before the run stopped.',
            commandId: 'rtc-realtime-position-stream',
            evidenceFile: 'events.jsonl',
            minimalFixArea: 'RTC/TURN',
        });
        expect(analysis.fixProposalMarkdown).toContain('RTC stream did not finish');
        expect(analysis.fixProposalMarkdown).not.toContain('no specific failure evidence was exported');
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
                        { phase: 'start', agentId: 'controller-01', commandId: 'start-1' },
                    ],
                    rollup: {
                        ok: true,
                        summary: {
                            participants: 1,
                            passedParticipants: 1,
                            failedParticipants: 0,
                            blockingFailures: 0,
                        },
                    },
                    manifest: {
                        group: {
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            groupId: 'bb-group',
                        },
                    },
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-linked-timing',
                    agents: [
                        { agentId: 'controller-01', connected: true, reconnectCount: 0, receivedEventCount: 0 },
                    ],
                    commands: [
                        {
                            envelope: {
                                agentId: 'controller-01',
                                commandId: 'stage-1',
                                command: { kind: 'recipe.load' },
                            },
                            dispatchedAtEpochMs: 1_100,
                            completedAtEpochMs: 1_600,
                        },
                        {
                            envelope: {
                                agentId: 'controller-01',
                                commandId: 'start-1',
                                command: { kind: 'recipe.run' },
                            },
                            dispatchedAtEpochMs: 1_800,
                            completedAtEpochMs: 2_800,
                        },
                    ],
                    results: [
                        {
                            agentId: 'controller-01',
                            commandId: 'reset-control-1',
                            ok: true,
                            result: { durationMs: 10_000 },
                        },
                    ],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
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
                        failureGroups: 0,
                    },
                    timing: {
                        commands: { count: 2, minMs: 50, p50Ms: 60, p95Ms: 70, maxMs: 70 },
                    },
                }),
            },
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
            outlierCount: 1,
        });
        expect(analysis.performance?.commandTiming.p99Ms).toBeLessThanOrEqual(
            analysis.performance?.commandTiming.maxMs ?? 0,
        );
        expect(analysis.performance?.commandTiming.outlierCount).toBeLessThanOrEqual(
            analysis.performance?.commandTiming.count ?? 0,
        );
        expect(analysis.performance?.slowestAgents).toEqual([
            {
                agentId: 'controller-01',
                commandCount: 2,
                averageMs: 750,
                maxMs: 1_000,
            },
        ]);
    });

    it('falls back to distributed and control artifacts when fleet report is missing', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-no-fleet',
                    controlRunId: 'run-no-fleet',
                    state: 'timed-out',
                    startedAtEpochMs: 2_000,
                    completedAtEpochMs: 12_000,
                    rollup: {
                        ok: false,
                        failures: [
                            {
                                kind: 'participant',
                                key: 'controller-03',
                                message: 'Missing stage ACK before timeout.',
                                code: 'ACK_TIMEOUT',
                                agentId: 'controller-03',
                            },
                        ],
                    },
                    manifest: {
                        group: {
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            groupId: 'bb-group',
                        },
                    },
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-no-fleet',
                    agents: [
                        { agentId: 'controller-01', connected: true, reconnectCount: 0, receivedEventCount: 1 },
                        { agentId: 'controller-03', connected: false, reconnectCount: 2, receivedEventCount: 0 },
                    ],
                    commands: [],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'results.jsonl': '',
                'events.jsonl': '',
                'failures.json': JSON.stringify({ failures: [] }),
            },
        });

        expect(analysis.ok).toBe(false);
        expect(analysis.status).toBe('timed-out');
        expect(analysis.failure?.category).toBe('readiness');
        expect(analysis.failure?.affectedAgents).toEqual(['controller-03']);
        expect(analysis.fixProposalMarkdown).toContain('Agent did not ACK staging');
        expect(analysis.fixProposalMarkdown).toContain('controller-03');
    });

    it('rejects malformed required JSON artifacts with a useful error', () => {
        expect(() =>
            analyzeDistributedRunArtifactFiles({
                files: {
                    'distributed-run.json': '{',
                    'control-run.json': JSON.stringify({ runId: 'run-bad', agents: [] }),
                },
            })
        ).toThrow(/distributed-run\.json is not valid JSON/);
    });

    it('keeps optional artifact parse errors visible without hiding the run verdict', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-warning',
                    controlRunId: 'run-warning',
                    state: 'passed',
                    startedAtEpochMs: 10,
                    completedAtEpochMs: 40,
                    rollup: { ok: true, summary: { blockingFailures: 0 } },
                    manifest: {
                        group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'bb-group' },
                        recipes: [],
                    },
                    targetAgentIds: [],
                    commandLinks: [],
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-warning',
                    agents: [
                        { agentId: 'agent-a', connected: true, reconnectCount: 0, receivedEventCount: 7 },
                    ],
                    commands: [],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'fleet-report.json': '{',
                'events.jsonl': [
                    JSON.stringify({ kind: 'runtime', value: { severity: 'info', message: 'loaded' } }),
                    '{not-json',
                ].join('\n'),
            },
            generatedAtEpochMs: 123,
        });

        expect(analysis.ok).toBe(true);
        expect(analysis.parseWarnings.map((warning) => warning.fileName)).toEqual([
            'fleet-report.json',
            'events.jsonl',
        ]);
        expect(analysis.performance?.diagnosticCount).toBe(0);
        expect(analysis.performance?.warningDiagnosticCount).toBe(0);
        expect(analysis.performance?.errorDiagnosticCount).toBe(0);
        expect(analysis.performance?.agentReportedEventCount).toBe(7);
        expect(analysis.summaryMarkdown).toContain('Artifact warnings: 2');
    });

    it('reports SPA derivation failures as artifact warnings', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-spa-warning',
                    controlRunId: 'run-spa-warning',
                    state: 'passed',
                    startedAtEpochMs: 1,
                    completedAtEpochMs: 2,
                    rollup: { ok: true, failures: [], summary: { blockingFailures: 0 } },
                    manifest: { recipes: [], group: { groupId: 'bb-group' } },
                    targetAgentIds: [],
                    commandLinks: [],
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-spa-warning',
                    agents: [],
                    commands: [{}],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
            },
        });

        expect(analysis.spa).toBeUndefined();
        expect(analysis.parseWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                fileName: 'spa-analysis',
                message: expect.stringContaining('Unable to derive SPA report'),
            }),
        ]));
        expect(analysis.ok).toBe(true);
    });

    it('builds a browser-safe v1-compatible bundle from partial CI artifact imports', () => {
        const files = {
            'distributed-run.json': JSON.stringify({
                distributedRunId: 'dist-import',
                controlRunId: 'run-import',
                state: 'passed',
                rollup: { ok: true, failures: [], summary: { blockingFailures: 0 } },
                manifest: { recipes: [], group: { groupId: 'bb-group' } },
                targetAgentIds: [],
                commandLinks: [],
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-import',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
            }),
            'manifest.json': JSON.stringify({ distributedRunId: 'dist-import' }),
            'events.jsonl': '',
            'results.jsonl': '',
        };
        const bundle = distributedArtifactBundleFromFiles(files, 456);
        const snapshots = distributedArtifactSnapshotsFromFiles(files, 456);
        const monitor = deriveDistributedRunMonitor({
            distributedRun: snapshots.distributedRun,
            controlRun: snapshots.controlRun,
            artifactBundle: bundle,
        });

        expect(bundle).toMatchObject({
            artifactSchemaVersion: 1,
            distributedRunId: 'dist-import',
            generatedAtEpochMs: 456,
            files: {
                'manifest.json': JSON.stringify({ distributedRunId: 'dist-import' }),
                'events.jsonl': '',
                'results.jsonl': '',
            },
        });
        expect(monitor.artifact).toMatchObject({ status: 'valid' });
    });

    it('keeps full v2 imported artifact bundles marked as v2', () => {
        const bundle = distributedArtifactBundleFromFiles({
            'distributed-run.json': JSON.stringify({ distributedRunId: 'dist-import-v2' }),
            'control-run.json': JSON.stringify({ runId: 'run-import-v2' }),
            'manifest.json': JSON.stringify({ distributedRunId: 'dist-import-v2' }),
            'report.json': '{}',
            'events.jsonl': '',
            'results.jsonl': '',
            'failures.json': '{}',
            'metadata.json': '{}',
        }, 789);

        expect(bundle?.artifactSchemaVersion).toBe(2);
        expect(bundle?.files).toMatchObject({
            'report.json': '{}',
            'failures.json': '{}',
            'metadata.json': '{}',
        });
    });

    it('uses payload diagnostic evidence when failed runs have no result failure', () => {
        const analysis = analyzeDistributedRunArtifactFiles({
            files: {
                'distributed-run.json': JSON.stringify({
                    distributedRunId: 'dist-payload-diagnostic',
                    controlRunId: 'run-payload-diagnostic',
                    state: 'failed',
                    startedAtEpochMs: 100,
                    completedAtEpochMs: 200,
                    rollup: { ok: false, failures: [], summary: { blockingFailures: 1 } },
                    manifest: { recipes: [], group: { groupId: 'bb-group' } },
                    targetAgentIds: ['agent-a'],
                    commandLinks: [],
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-payload-diagnostic',
                    agents: [{ agentId: 'agent-a', connected: true }],
                    commands: [{}],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'events.jsonl': JSON.stringify({
                    kind: 'diagnostic',
                    transport: 'realtime',
                    agentId: 'agent-a',
                    commandId: 'cmd-payload',
                    payload: {
                        severity: 'error',
                        message: 'Payload-only RTC route diagnostic.',
                    },
                }),
            },
        });

        expect(analysis.failure).toMatchObject({
            category: 'diagnostic',
            title: 'Payload-only RTC route diagnostic.',
            likelyCause: 'Payload-only RTC route diagnostic.',
            affectedAgents: ['agent-a'],
            commandId: 'cmd-payload',
            evidenceFile: 'events.jsonl',
        });
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
                        { phase: 'start', agentId: 'agent-b', commandId: 'cmd-c', queuedAtEpochMs: 1_030 },
                    ],
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-result-timing',
                    agents: [
                        { agentId: 'agent-a', connected: true, reconnectCount: 0, receivedEventCount: 1 },
                        { agentId: 'agent-b', connected: true, reconnectCount: 0, receivedEventCount: 1 },
                    ],
                    commands: [
                        { envelope: { agentId: 'agent-a', commandId: 'cmd-a', command: { kind: 'health' } } },
                        { envelope: { agentId: 'agent-b', commandId: 'cmd-b', command: { kind: 'health' } } },
                        { envelope: { agentId: 'agent-b', commandId: 'cmd-c', command: { kind: 'health' } } },
                    ],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                }),
                'results.jsonl': [
                    JSON.stringify({ agentId: 'agent-a', commandId: 'cmd-a', ok: true, result: { durationMs: 20 } }),
                    JSON.stringify({ agentId: 'agent-b', commandId: 'cmd-b', ok: true, result: { durationMs: 40 } }),
                    JSON.stringify({ agentId: 'agent-b', commandId: 'cmd-c', ok: true, result: { startedAtEpochMs: 1_100, endedAtEpochMs: 1_500 } }),
                ].join('\n'),
            },
        });

        expect(analysis.performance?.commandTiming).toMatchObject({
            count: 3,
            minMs: 20,
            p50Ms: 40,
            p95Ms: 400,
            p99Ms: 400,
            maxMs: 400,
        });
        expect(analysis.performance?.slowestAgents[0]).toMatchObject({
            agentId: 'agent-b',
            commandCount: 2,
            maxMs: 400,
            averageMs: 220,
        });
    });

    it('writes CLI analysis files for failed and passed artifact directories', async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), 'rallar-distributed-artifacts-'));
        const outDir = path.join(artifactDir, 'analysis');
        await writeFile(path.join(artifactDir, 'distributed-run.json'), JSON.stringify({
            distributedRunId: 'dist-cli',
            controlRunId: 'run-cli',
            state: 'failed',
            startedAtEpochMs: 1,
            completedAtEpochMs: 5,
            rollup: {
                ok: false,
                failures: [{
                    kind: 'participant',
                    key: 'agent-a',
                    state: 'failed',
                    error: { code: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT', message: 'Missing ACK.' },
                }],
                summary: { blockingFailures: 1 },
            },
            manifest: { recipes: [], group: { groupId: 'bb-group' } },
            targetAgentIds: ['agent-a'],
            commandLinks: [],
        }));
        await writeFile(path.join(artifactDir, 'control-run.json'), JSON.stringify({
            runId: 'run-cli',
            agents: [],
            commands: [],
            results: [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: [],
        }));

        await analyzeDistributedRunArtifactDirectory(artifactDir, outDir);

        const analysis = JSON.parse(await readFile(path.join(outDir, 'analysis.json'), 'utf8')) as {
            failure?: { minimalFixArea?: string };
            parseWarnings: unknown[];
        };
        expect(analysis.failure?.minimalFixArea).toBe('headless agent readiness');
        expect(analysis.parseWarnings).toEqual([]);
        await expect(readFile(path.join(outDir, 'summary.md'), 'utf8')).resolves.toContain('dist-cli');
        await expect(readFile(path.join(outDir, 'fix-proposal.md'), 'utf8')).resolves.toContain('Suggested verification');
    });

    it('writes passed-run performance files with percentile and diagnostic severity counts', async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), 'rallar-distributed-passed-artifacts-'));
        const outDir = path.join(artifactDir, 'analysis');
        await writeFile(path.join(artifactDir, 'distributed-run.json'), JSON.stringify({
            distributedRunId: 'dist-cli-passed',
            controlRunId: 'run-cli-passed',
            state: 'passed',
            startedAtEpochMs: 100,
            completedAtEpochMs: 900,
            rollup: { ok: true, failures: [], summary: { blockingFailures: 0 } },
            manifest: { recipes: [], group: { groupId: 'bb-group' } },
            targetAgentIds: ['agent-a', 'agent-b'],
            commandLinks: [
                { phase: 'start', agentId: 'agent-a', commandId: 'cmd-a', queuedAtEpochMs: 100 },
                { phase: 'start', agentId: 'agent-b', commandId: 'cmd-b', queuedAtEpochMs: 100 },
                { phase: 'start', agentId: 'agent-b', commandId: 'cmd-c', queuedAtEpochMs: 100 },
            ],
        }));
        await writeFile(path.join(artifactDir, 'control-run.json'), JSON.stringify({
            runId: 'run-cli-passed',
            agents: [
                { agentId: 'agent-a', connected: true, reconnectCount: 0, receivedEventCount: 2 },
                { agentId: 'agent-b', connected: true, reconnectCount: 1, receivedEventCount: 3 },
            ],
            commands: [
                { envelope: { agentId: 'agent-a', commandId: 'cmd-a', command: { kind: 'health' } }, dispatchedAtEpochMs: 110, completedAtEpochMs: 130 },
                { envelope: { agentId: 'agent-b', commandId: 'cmd-b', command: { kind: 'health' } }, dispatchedAtEpochMs: 120, completedAtEpochMs: 160 },
                { envelope: { agentId: 'agent-b', commandId: 'cmd-c', command: { kind: 'health' } }, dispatchedAtEpochMs: 130, completedAtEpochMs: 530 },
            ],
            results: [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: [],
        }));
        await writeFile(path.join(artifactDir, 'events.jsonl'), [
            JSON.stringify({ kind: 'runtime', value: { severity: 'info', message: 'loaded' } }),
            JSON.stringify({ kind: 'runtime', value: { severity: 'warning', message: 'slow route' } }),
        ].join('\n'));

        await analyzeDistributedRunArtifactDirectory(artifactDir, outDir);

        const analysis = JSON.parse(await readFile(path.join(outDir, 'analysis.json'), 'utf8')) as {
            performance?: {
                diagnosticCount: number;
                warningDiagnosticCount: number;
                errorDiagnosticCount: number;
                commandTiming: {
                    p99Ms?: number;
                    outlierCount?: number;
                };
            };
        };
        expect(analysis.performance?.diagnosticCount).toBe(1);
        expect(analysis.performance?.warningDiagnosticCount).toBe(1);
        expect(analysis.performance?.errorDiagnosticCount).toBe(0);
        expect(analysis.performance?.commandTiming.p99Ms).toBe(400);
        expect(analysis.performance?.commandTiming.outlierCount).toBe(1);
        const performance = await readFile(path.join(outDir, 'performance.md'), 'utf8');
        expect(performance).toContain('p99=400ms');
        expect(performance).toContain('Warning diagnostics: 1');
        expect(performance).toContain('Error diagnostics: 0');
    });
});
