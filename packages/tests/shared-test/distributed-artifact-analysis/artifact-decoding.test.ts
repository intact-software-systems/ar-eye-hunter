import { describe, expect, it } from 'vitest';

import {
    computeDistributedRunArtifactAnalysis,
    toDistributedArtifactBundle,
    toDistributedArtifactSnapshots,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { deriveDistributedRunMonitor } from '../../../shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    createControlRunSnapshot,
    createDistributedRunSnapshot,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

const GENERATED_AT_EPOCH_MS = 123;

function analyzedRun(files: DistributedRunArtifactFiles): DistributedRunAnalysis {
    const analyzed = computeDistributedRunArtifactAnalysis({ files, generatedAtEpochMs: GENERATED_AT_EPOCH_MS });
    if (analyzed.right?.variant !== 'distributed-run') {
        throw new Error(`Expected a distributed run analysis, got ${JSON.stringify(analyzed.left ?? analyzed.right)}`);
    }
    return analyzed.right.analysis;
}

function passedRunFiles(files: DistributedRunArtifactFiles = {}): DistributedRunArtifactFiles {
    return toDistributedRunArtifactFiles({
        distributedRun: createDistributedRunSnapshot({
            distributedRunId: 'dist-decoded',
            controlRunId: 'run-decoded',
            state: 'passed',
            agentIds: ['agent-a'],
            startedAtEpochMs: 10,
            completedAtEpochMs: 40
        }),
        controlRun: createControlRunSnapshot({
            runId: 'run-decoded',
            agents: [{ agentId: 'agent-a', receivedEventCount: 7 }]
        }),
        files
    });
}

describe('distributed run artifact decoding', () => {
    it('includes target-resolution evidence in analysis summaries', () => {
        const files = toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-world-fleet',
                controlRunId: 'run-world-fleet',
                state: 'failed',
                agentIds: ['agent-01', 'agent-02']
            }),
            controlRun: createControlRunSnapshot({ runId: 'run-world-fleet' }),
            files: {
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
            }
        });

        const analysis = analyzedRun(files);

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

    it('promotes JSONL rows that name their agent, command and outcome without inventing envelopes or command links', () => {
        const files = toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-jsonl-only',
                controlRunId: 'run-jsonl-only',
                state: 'failed',
                agentIds: ['agent-a'],
                startedAtEpochMs: 1_000,
                completedAtEpochMs: 2_000
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-jsonl-only',
                agents: [{ agentId: 'agent-a', receivedEventCount: 1 }]
            }),
            files: {
                'results.jsonl': [
                    JSON.stringify({
                        resultKey: 'agent-a:send-rtc',
                        status: 'FAILURE',
                        agentId: 'agent-a',
                        action: 'rtc.send',
                        actual: {
                            code: 'RTC_NO_ROUTE',
                            message: 'No route to peer.'
                        }
                    }),
                    JSON.stringify({ status: 'FAILURE', action: 'rtc.send' })
                ].join('\n'),
                'events.jsonl': JSON.stringify({
                    kind: 'rtc-diagnostic',
                    transport: 'realtime',
                    agentId: 'agent-a',
                    value: {
                        severity: 'error',
                        message: 'No RTC route to receiver.'
                    }
                })
            }
        });

        const analysis = analyzedRun(files);
        const snapshots = toDistributedArtifactSnapshots(files, GENERATED_AT_EPOCH_MS).right;

        expect(analysis.failure).toMatchObject({
            commandId: 'send-rtc',
            affectedAgents: ['agent-a'],
            evidenceFile: 'results.jsonl'
        });
        expect(analysis.performance?.errorDiagnosticCount).toBe(1);
        expect(snapshots?.distributedRun.commandLinks).toEqual([]);
        expect(snapshots?.controlRun.results).toEqual([{
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-jsonl-only',
            agentId: 'agent-a',
            commandId: 'send-rtc',
            ok: false,
            error: { code: 'RTC_NO_ROUTE', message: 'No route to peer.' }
        }]);
        expect(snapshots?.controlRun.events).toEqual([]);
    });

    it('rejects artifacts that hold neither a distributed run snapshot nor a failed control request record', () => {
        const analyzed = computeDistributedRunArtifactAnalysis({
            files: {
                'runner-summary.json': JSON.stringify({
                    distributedRunId: 'dist-missing',
                    controlRunId: 'run-missing',
                    state: 'failed',
                    ok: false,
                    artifactDir: '/artifacts/dist-missing'
                }),
                'control-run.json': JSON.stringify(createControlRunSnapshot({ runId: 'run-missing' }))
            },
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(analyzed.left).toEqual({
            fileName: 'distributed-run.json',
            message: 'distributed-run.json is required: the artifacts hold neither a distributed run snapshot nor a failed control request record.'
        });
    });

    it('rejects an empty distributed-run.json instead of rebuilding the run from the runner summary and manifest', () => {
        const analyzed = computeDistributedRunArtifactAnalysis({
            files: {
                ...passedRunFiles(),
                'distributed-run.json': '',
                'runner-summary.json': JSON.stringify({
                    distributedRunId: 'dist-decoded',
                    controlRunId: 'run-decoded',
                    state: 'timed-out',
                    ok: false,
                    artifactDir: '/artifacts/dist-decoded'
                })
            },
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(analyzed.left).toEqual({
            fileName: 'distributed-run.json',
            message: 'distributed-run.json is required and must not be empty.'
        });
    });

    it('rejects malformed required JSON artifacts with a useful error', () => {
        const analyzed = computeDistributedRunArtifactAnalysis({
            files: {
                ...passedRunFiles(),
                'distributed-run.json': '{'
            },
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(analyzed.left?.fileName).toBe('distributed-run.json');
        expect(analyzed.left?.message).toMatch(/^distributed-run\.json is not valid JSON: /);
    });

    it('rejects snapshots that omit a required key instead of substituting a placeholder', () => {
        const distributedRun = createDistributedRunSnapshot({
            distributedRunId: 'dist-decoded',
            controlRunId: 'run-decoded',
            state: 'passed',
            agentIds: ['agent-a']
        });
        const controlRun = createControlRunSnapshot({ runId: 'run-decoded', agents: [{ agentId: 'agent-a' }] });
        const { createdAtEpochMs: _createdAtEpochMs, ...runWithoutCreatedAt } = distributedRun;
        const { blockingFailures: _blockingFailures, ...partialSummary } = distributedRun.rollup.summary;
        const cases = [
            {
                name: 'distributed run without createdAtEpochMs',
                files: { 'distributed-run.json': JSON.stringify(runWithoutCreatedAt) },
                expected: {
                    fileName: 'distributed-run.json',
                    message: 'distributed-run.json is not a distributed run snapshot: createdAtEpochMs must be a finite number.'
                }
            },
            {
                name: 'command link without queuedAtEpochMs',
                files: {
                    'distributed-run.json': JSON.stringify({
                        ...distributedRun,
                        commandLinks: [{ phase: 'start', agentId: 'agent-a', commandId: 'start-a' }]
                    })
                },
                expected: {
                    fileName: 'distributed-run.json',
                    message: 'distributed-run.json is not a distributed run snapshot: commandLinks[0].queuedAtEpochMs must be a finite number.'
                }
            },
            {
                name: 'rollup summary without blockingFailures',
                files: {
                    'distributed-run.json': JSON.stringify({
                        ...distributedRun,
                        rollup: { ...distributedRun.rollup, summary: partialSummary }
                    })
                },
                expected: {
                    fileName: 'distributed-run.json',
                    message: 'distributed-run.json is not a distributed run snapshot: rollup.summary.blockingFailures must be a finite number.'
                }
            },
            {
                name: 'control run recorded as null',
                files: { 'control-run.json': 'null' },
                expected: {
                    fileName: 'control-run.json',
                    message: 'control-run.json is not a control run snapshot: the snapshot must be a JSON object.'
                }
            },
            {
                name: 'control run command that is not a control command',
                files: { 'control-run.json': JSON.stringify({ ...controlRun, commands: [{}] }) },
                expected: {
                    fileName: 'control-run.json',
                    message: 'control-run.json is not a control run snapshot: commands[0].envelope must be a JSON object.'
                }
            },
            {
                name: 'control run agent without its counters',
                files: {
                    'control-run.json': JSON.stringify({
                        ...controlRun,
                        agents: [{ runId: 'run-decoded', agentId: 'agent-a', connected: true }]
                    })
                },
                expected: {
                    fileName: 'control-run.json',
                    message: 'control-run.json is not a control run snapshot: agents[0].connectionSequence must be a finite number.'
                }
            }
        ];

        for (const decodeCase of cases) {
            const analyzed = computeDistributedRunArtifactAnalysis({
                files: { ...passedRunFiles(), ...decodeCase.files },
                generatedAtEpochMs: GENERATED_AT_EPOCH_MS
            });
            expect(analyzed.left, decodeCase.name).toEqual(decodeCase.expected);
        }
    });

    it('keeps optional artifact parse errors visible without hiding the run verdict', () => {
        const analysis = analyzedRun(passedRunFiles({
            'fleet-report.json': '{',
            'events.jsonl': [
                JSON.stringify({ kind: 'runtime', value: { severity: 'info', message: 'loaded' } }),
                '{not-json'
            ].join('\n')
        }));

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

    it('builds a browser-safe v1 bundle from the snapshot files, manifest and JSONL evidence', () => {
        const files = passedRunFiles({ 'events.jsonl': '', 'results.jsonl': '' });
        const bundle = toDistributedArtifactBundle(files, 456).right;
        const snapshots = toDistributedArtifactSnapshots(files, 456).right;
        const monitor = snapshots && deriveDistributedRunMonitor({
            distributedRun: snapshots.distributedRun,
            controlRun: snapshots.controlRun,
            artifactBundle: bundle
        });

        expect(bundle).toMatchObject({
            artifactSchemaVersion: 1,
            distributedRunId: 'dist-decoded',
            generatedAtEpochMs: 456,
            files: {
                'manifest.json': files['manifest.json'],
                'events.jsonl': '',
                'results.jsonl': ''
            }
        });
        expect(snapshots?.artifactBundle).toEqual(bundle);
        expect(monitor?.artifact).toMatchObject({ status: 'valid' });
    });

    it('keeps full v2 imported artifact bundles marked as v2', () => {
        const bundle = toDistributedArtifactBundle(
            passedRunFiles({
                'report.json': '{}',
                'events.jsonl': '',
                'results.jsonl': '',
                'failures.json': '{}',
                'metadata.json': '{}'
            }),
            789
        ).right;

        expect(bundle?.artifactSchemaVersion).toBe(2);
        expect(bundle?.files).toMatchObject({
            'report.json': '{}',
            'failures.json': '{}',
            'metadata.json': '{}'
        });
    });

    it('reports a missing manifest.json as an analysis warning instead of bundling the run snapshot as the manifest', () => {
        const { 'manifest.json': _manifest, ...filesWithoutManifest } = passedRunFiles();
        const bundle = toDistributedArtifactBundle(filesWithoutManifest, 456);
        const analysis = analyzedRun(filesWithoutManifest);

        expect(bundle.left).toEqual({
            fileName: 'manifest.json',
            message: 'manifest.json is required to form a distributed-run artifact bundle.'
        });
        expect(analysis.parseWarnings).toEqual([bundle.left]);
        expect(analysis.spa?.verdict).toBeDefined();
    });
});
