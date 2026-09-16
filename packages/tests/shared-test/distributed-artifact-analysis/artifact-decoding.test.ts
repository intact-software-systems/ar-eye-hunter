import { describe, expect, it } from 'vitest';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunArtifactFiles
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { deriveDistributedRunMonitor } from '../../../shared-test/rallar-bb-test/distributed-run-monitor.ts';

describe('distributed run artifact decoding', () => {
    it('includes target-resolution evidence in analysis summaries', () => {
        const files: DistributedRunArtifactFiles = {
            'distributed-run.json': JSON.stringify({
                distributedRunId: 'dist-world-fleet',
                controlRunId: 'run-world-fleet',
                state: 'failed',
                targetAgentIds: ['agent-01', 'agent-02'],
                commandLinks: [],
                rollup: { ok: false, failures: [], summary: { blockingFailures: 1 } },
                manifest: {
                    recipes: [],
                    group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'bb-group' }
                }
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-world-fleet',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            }),
            'target-resolution.json': JSON.stringify({
                targetAgentIds: ['agent-01', 'agent-02'],
                roleAssignments: [
                    { agentId: 'agent-01', role: 'sender', required: true },
                    { agentId: 'agent-02', role: 'receiver', required: true }
                ],
                blockers: [
                    { agentId: 'agent-03', status: 'stale-agent', reason: 'stale' }
                ],
                summary: {
                    selected: 2,
                    expectedParticipantCount: 3,
                    missingExpectedParticipants: 1,
                    staleAgents: 1,
                    offlineAgents: 0,
                    wrongGroupAgents: 0,
                    agentsWithoutIdentity: 0,
                    roleCounts: { receiver: 1, sender: 1 },
                    regions: { 'eu-north': 2 },
                    providers: { hetzner: 2 }
                }
            })
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });

        expect(analysis.targetResolution).toMatchObject({
            selected: 2,
            expectedParticipantCount: 3,
            missingExpectedParticipants: 1,
            blockers: 1,
            blockingAgentIds: ['agent-03'],
            roleCounts: { receiver: 1, sender: 1 }
        });
        expect(analysis.summaryMarkdown).toContain('Targets: 2/3 resolved');
        expect(analysis.summaryMarkdown).toContain('Target blockers: 1');
    });

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
                    group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'bb-group' }
                }
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-jsonl-only',
                agents: [{ agentId: 'agent-a', connected: true, reconnectCount: 0, receivedEventCount: 1 }],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            }),
            'results.jsonl': JSON.stringify({
                resultKey: 'agent-a:send-rtc',
                status: 'FAILURE',
                agentId: 'agent-a',
                action: 'rtc.send',
                actual: {
                    code: 'RTC_NO_ROUTE',
                    message: 'No route to peer.'
                }
            }),
            'events.jsonl': JSON.stringify({
                kind: 'rtc-diagnostic',
                transport: 'realtime',
                agentId: 'agent-a',
                value: {
                    severity: 'error',
                    message: 'No RTC route to receiver.'
                }
            })
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });
        const snapshots = distributedArtifactSnapshotsFromFiles(files, 123);

        expect(analysis.failure).toMatchObject({
            commandId: 'send-rtc',
            affectedAgents: ['agent-a']
        });
        expect(analysis.spa?.report.firstFailure).toMatchObject({
            commandId: 'send-rtc',
            agentId: 'agent-a'
        });
        expect(snapshots.distributedRun.commandLinks.map((link) => link.commandId)).toEqual(['send-rtc']);
        expect(snapshots.controlRun.results.map((result) => [result.commandId, result.ok])).toEqual([
            ['send-rtc', false]
        ]);
        expect(snapshots.controlRun.events.map((event) => [event.kind, event.agentId])).toEqual([
            ['diagnostic', 'agent-a']
        ]);
    });

    it('uses runner summary and manifest fallbacks when the distributed-run snapshot is empty', () => {
        const files: DistributedRunArtifactFiles = {
            'distributed-run.json': '',
            'runner-summary.json': JSON.stringify({
                distributedRunId: 'dist-empty-snapshot',
                controlRunId: 'run-empty-snapshot',
                state: 'timed-out',
                ok: false
            }),
            'manifest.json': JSON.stringify({
                schemaVersion: 1,
                distributedRunId: 'dist-empty-snapshot',
                controlRunId: 'run-empty-snapshot',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'hetzner-headless-room'
                },
                recipes: []
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-empty-snapshot',
                agents: [{ agentId: 'controller-01', connected: true }],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
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
                    observations: [{ durationMs: 1_350, dropped: false }]
                },
                error: {
                    code: 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED',
                    message: 'RTC stream had failed frame sends.'
                }
            }),
            'events.jsonl': JSON.stringify({
                kind: 'diagnostic',
                topic: 'rallar.bb.rtc.stream_failed',
                agentId: 'controller-01',
                commandId: 'rtc-realtime-position-stream',
                payload: {
                    severity: 'error',
                    message: 'RTC stream had failed frame sends.'
                }
            }),
            'failures.json': JSON.stringify({
                failures: [{
                    agentId: 'controller-01',
                    commandId: 'rtc-realtime-position-stream',
                    error: {
                        code: 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED',
                        message: 'RTC stream had failed frame sends.'
                    }
                }]
            })
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });
        const snapshots = distributedArtifactSnapshotsFromFiles(files, 123);
        const monitor = deriveDistributedRunMonitor({
            distributedRun: snapshots.distributedRun,
            controlRun: snapshots.controlRun,
            artifactBundle: snapshots.artifactBundle
        });

        expect(analysis).toMatchObject({
            distributedRunId: 'dist-empty-snapshot',
            controlRunId: 'run-empty-snapshot',
            status: 'timed-out',
            ok: false,
            failure: {
                commandId: 'rtc-realtime-position-stream',
                evidenceFile: 'results.jsonl'
            }
        });
        expect(analysis.parseWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                fileName: 'distributed-run.json',
                message: expect.stringContaining('using runner-summary.json and manifest.json fallback')
            })
        ]));
        expect(analysis.performance?.streamTiming).toMatchObject({
            plannedFrames: 100,
            completedFrames: 82,
            droppedFrames: 18
        });
        expect(monitor.artifact).toMatchObject({ status: 'invalid-json' });
        expect(snapshots.distributedRun.manifest.group).toMatchObject({
            groupId: 'hetzner-headless-room'
        });
    });

    it('rejects malformed required JSON artifacts with a useful error', () => {
        expect(() =>
            analyzeDistributedRunArtifactFiles({
                files: {
                    'distributed-run.json': '{',
                    'control-run.json': JSON.stringify({ runId: 'run-bad', agents: [] })
                }
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
                        recipes: []
                    },
                    targetAgentIds: [],
                    commandLinks: []
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-warning',
                    agents: [
                        { agentId: 'agent-a', connected: true, reconnectCount: 0, receivedEventCount: 7 }
                    ],
                    commands: [],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: []
                }),
                'fleet-report.json': '{',
                'events.jsonl': [
                    JSON.stringify({ kind: 'runtime', value: { severity: 'info', message: 'loaded' } }),
                    '{not-json'
                ].join('\n')
            },
            generatedAtEpochMs: 123
        });

        expect(analysis.ok).toBe(true);
        expect(analysis.parseWarnings.map((warning) => warning.fileName)).toEqual([
            'fleet-report.json',
            'events.jsonl'
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
                    commandLinks: []
                }),
                'control-run.json': JSON.stringify({
                    runId: 'run-spa-warning',
                    agents: [],
                    commands: [{}],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: []
                })
            }
        });

        expect(analysis.spa).toBeUndefined();
        expect(analysis.parseWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                fileName: 'spa-analysis',
                message: expect.stringContaining('Unable to derive SPA report')
            })
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
                commandLinks: []
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-import',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            }),
            'manifest.json': JSON.stringify({ distributedRunId: 'dist-import' }),
            'events.jsonl': '',
            'results.jsonl': ''
        };
        const bundle = distributedArtifactBundleFromFiles(files, 456);
        const snapshots = distributedArtifactSnapshotsFromFiles(files, 456);
        const monitor = deriveDistributedRunMonitor({
            distributedRun: snapshots.distributedRun,
            controlRun: snapshots.controlRun,
            artifactBundle: bundle
        });

        expect(bundle).toMatchObject({
            artifactSchemaVersion: 1,
            distributedRunId: 'dist-import',
            generatedAtEpochMs: 456,
            files: {
                'manifest.json': JSON.stringify({ distributedRunId: 'dist-import' }),
                'events.jsonl': '',
                'results.jsonl': ''
            }
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
            'metadata.json': '{}'
        }, 789);

        expect(bundle?.artifactSchemaVersion).toBe(2);
        expect(bundle?.files).toMatchObject({
            'report.json': '{}',
            'failures.json': '{}',
            'metadata.json': '{}'
        });
    });
});
