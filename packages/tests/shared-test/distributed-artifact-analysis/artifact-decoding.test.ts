import { describe, expect, it } from 'vitest';

import {
    computeDistributedRunArtifactAnalysis,
    toDistributedArtifactBundle,
    toDistributedArtifactSnapshots,
    type DistributedRunArtifactFiles
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { deriveDistributedRunMonitor } from '../../../shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RallarBlackBoxDistributedTargetResolution } from '../../../shared-test/rallar-bb-test/distributed-run.ts';
import {
    computeDistributedRunAnalysis,
    computeFailedDistributedRunAnalysis,
    createControlRunSnapshot,
    createDistributedRunSnapshot,
    FIXTURE_GROUP,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

const GENERATED_AT_EPOCH_MS = 123;

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

const WORLD_FLEET_TARGET_RESOLUTION: RallarBlackBoxDistributedTargetResolution = {
    group: FIXTURE_GROUP,
    resolvedAtEpochMs: 5,
    staleAfterMs: 30_000,
    targetPolicyMode: 'selected-agents',
    targetAgentIds: ['agent-01', 'agent-02'],
    roleAssignments: [
        { agentId: 'agent-01', role: 'sender', recipeIds: [], required: true, variables: {} },
        { agentId: 'agent-02', role: 'receiver', recipeIds: [], required: true, variables: {} }
    ],
    blockers: [
        { agentId: 'agent-03', status: 'stale-agent', reason: 'stale', identity: { principalId: 'agent-03' } }
    ],
    summary: {
        agents: 3,
        targetable: 2,
        selected: 2,
        expectedParticipantCount: 3,
        missingExpectedParticipants: 1,
        staleAgents: 1,
        offlineAgents: 0,
        wrongGroupAgents: 0,
        assertionCapabilityBlockedAgents: 0,
        agentsWithoutIdentity: 0,
        roleCounts: { sender: 1, receiver: 1 },
        regions: { 'eu-north': 2 },
        providers: { hetzner: 2 }
    }
};

const GROUP_ASSERTION_RESULT = {
    groupAssertionId: 'members-match',
    aggregate: 'allMatch',
    ok: true,
    participants: { expected: 1, required: 1, withEvidence: 1, matching: 1 },
    missingAgentIds: [],
    violatingAgentIds: [],
    perAgent: [{ agentId: 'agent-a', evidence: 'resolved', verdict: 'matching', value: 1 }]
};

function worldFleetFiles(files: DistributedRunArtifactFiles): DistributedRunArtifactFiles {
    return toDistributedRunArtifactFiles({
        distributedRun: createDistributedRunSnapshot({
            distributedRunId: 'dist-world-fleet',
            controlRunId: 'run-world-fleet',
            state: 'failed',
            agentIds: ['agent-01', 'agent-02']
        }),
        controlRun: createControlRunSnapshot({ runId: 'run-world-fleet' }),
        files
    });
}

describe('distributed run artifact decoding', () => {
    it('includes target-resolution evidence in analysis summaries', () => {
        const analysis = computeDistributedRunAnalysis(
            worldFleetFiles({
                'target-resolution.json': JSON.stringify(WORLD_FLEET_TARGET_RESOLUTION)
            }),
            GENERATED_AT_EPOCH_MS
        );

        expect(analysis.parseWarnings).toEqual([]);
        expect(analysis.targetResolution).toEqual({
            selected: 2,
            expectedParticipantCount: 3,
            missingExpectedParticipants: 1,
            blockers: 1,
            staleAgents: 1,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: { receiver: 1, sender: 1 },
            regions: { 'eu-north': 2 },
            providers: { hetzner: 2 },
            targetAgentIds: ['agent-01', 'agent-02'],
            blockingAgentIds: ['agent-03']
        });
        expect(analysis.summaryMarkdown).toContain('Targets: 2/3 resolved');
        expect(analysis.summaryMarkdown).toContain('Target blockers: 1');
    });

    it('warns about a target-resolution.json that omits a counter instead of counting it as zero', () => {
        const { staleAgents: _staleAgents, ...summaryWithoutStaleAgents } = WORLD_FLEET_TARGET_RESOLUTION.summary;
        const analysis = computeDistributedRunAnalysis(
            worldFleetFiles({
                'target-resolution.json': JSON.stringify({
                    ...WORLD_FLEET_TARGET_RESOLUTION,
                    summary: summaryWithoutStaleAgents
                })
            }),
            GENERATED_AT_EPOCH_MS
        );

        expect(analysis.parseWarnings).toEqual([{
            fileName: 'target-resolution.json',
            message: 'target-resolution.json is not a target resolution: targetResolution.summary.staleAgents must be a finite number.'
        }]);
        expect(analysis.targetResolution).toBeUndefined();
        expect(analysis.summaryMarkdown).not.toContain('Targets:');
    });

    it('reads a target-resolution.json that records null as no target resolution', () => {
        const analysis = computeDistributedRunAnalysis(worldFleetFiles({ 'target-resolution.json': 'null' }), GENERATED_AT_EPOCH_MS);

        expect(analysis.parseWarnings).toEqual([]);
        expect(analysis.targetResolution).toBeUndefined();
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

        const analysis = computeFailedDistributedRunAnalysis(files, GENERATED_AT_EPOCH_MS);
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

    it('warns about JSONL rows that cannot stand in for control envelopes instead of dropping them silently', () => {
        const files = toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-jsonl-stand-in',
                controlRunId: 'run-jsonl-stand-in',
                state: 'passed',
                agentIds: ['agent-a']
            }),
            controlRun: createControlRunSnapshot({ runId: 'run-jsonl-stand-in', agents: [{ agentId: 'agent-a' }] }),
            files: {
                'results.jsonl': [
                    JSON.stringify({ resultKey: 'agent-a:health', status: 'SUCCESS', agentId: 'agent-a' }),
                    JSON.stringify({ status: 'FAILURE', action: 'rtc.send' }),
                    JSON.stringify({ agentId: 'agent-a', commandId: 'wait', status: 'PENDING' })
                ].join('\n'),
                'events.jsonl': [
                    JSON.stringify({
                        kind: 'step-result',
                        name: 'health',
                        status: 'SUCCESS',
                        agentId: 'agent-a',
                        commandId: 'health'
                    }),
                    JSON.stringify({
                        kind: 'runtime',
                        status: 'event',
                        agentId: 'agent-a',
                        commandId: 'health',
                        atEpochMs: 5,
                        value: { message: 'loaded' }
                    }),
                    JSON.stringify({
                        kind: 'rtc-diagnostic',
                        agentId: 'agent-a',
                        value: { severity: 'error', message: 'No RTC route.' }
                    })
                ].join('\n')
            }
        });

        const analysis = computeDistributedRunAnalysis(files, GENERATED_AT_EPOCH_MS);
        const snapshots = toDistributedArtifactSnapshots(files, GENERATED_AT_EPOCH_MS).right;

        expect(analysis.parseWarnings).toEqual([
            {
                fileName: 'results.jsonl',
                lineNumber: 2,
                message: 'results.jsonl:2 cannot stand in for a control result: agentId must be a non-empty string.'
            },
            {
                fileName: 'results.jsonl',
                lineNumber: 3,
                message: 'results.jsonl:3 cannot stand in for a control result: ok must be a boolean or status must be SUCCESS or FAILURE.'
            },
            {
                fileName: 'events.jsonl',
                lineNumber: 3,
                message: 'events.jsonl:3 cannot stand in for a control event: atEpochMs must be a finite number.'
            }
        ]);
        expect(snapshots?.controlRun.results.map((result) => result.commandId)).toEqual(['health']);
        expect(snapshots?.controlRun.events.map((event) => event.commandId)).toEqual(['health']);
        expect(snapshots?.parseWarnings).toEqual(analysis.parseWarnings);
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
                name: 'derived role assignment without its recipe scope',
                files: {
                    'distributed-run.json': JSON.stringify({
                        ...distributedRun,
                        targetResolution: {
                            ...WORLD_FLEET_TARGET_RESOLUTION,
                            roleAssignments: [{ agentId: 'agent-01', role: 'sender', required: true }]
                        }
                    })
                },
                expected: {
                    fileName: 'distributed-run.json',
                    message:
                        'distributed-run.json is not a distributed run snapshot: targetResolution.roleAssignments[0].recipeIds must be an array of strings.'
                }
            },
            {
                name: 'target resolution summary without the assertion capability counter',
                files: {
                    'distributed-run.json': JSON.stringify({
                        ...distributedRun,
                        targetResolution: {
                            ...WORLD_FLEET_TARGET_RESOLUTION,
                            summary: { ...WORLD_FLEET_TARGET_RESOLUTION.summary, assertionCapabilityBlockedAgents: undefined }
                        }
                    })
                },
                expected: {
                    fileName: 'distributed-run.json',
                    message:
                        'distributed-run.json is not a distributed run snapshot: targetResolution.summary.assertionCapabilityBlockedAgents must be a finite number.'
                }
            },
            {
                name: 'resolved group assertion row without a verdict',
                files: {
                    'distributed-run.json': JSON.stringify({
                        ...distributedRun,
                        rollup: {
                            ...distributedRun.rollup,
                            groupAssertions: [{
                                ...GROUP_ASSERTION_RESULT,
                                perAgent: [{ agentId: 'agent-a', evidence: 'resolved', value: 1 }]
                            }]
                        }
                    })
                },
                expected: {
                    fileName: 'distributed-run.json',
                    message:
                        'distributed-run.json is not a distributed run snapshot: rollup.groupAssertions[0].perAgent[0].verdict must be a group assertion verdict for resolved evidence.'
                }
            },
            {
                name: 'predicate group assertion counts without a matching count',
                files: {
                    'distributed-run.json': JSON.stringify({
                        ...distributedRun,
                        rollup: {
                            ...distributedRun.rollup,
                            groupAssertions: [{
                                ...GROUP_ASSERTION_RESULT,
                                participants: { expected: 1, required: 1, withEvidence: 1 }
                            }]
                        }
                    })
                },
                expected: {
                    fileName: 'distributed-run.json',
                    message:
                        'distributed-run.json is not a distributed run snapshot: rollup.groupAssertions[0].participants.matching must be a finite number for a allMatch assertion.'
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

    it('warns about a control-run.json that is not a control run snapshot and forms nothing that needs the control run', () => {
        const controlRun = createControlRunSnapshot({ runId: 'run-decoded', agents: [{ agentId: 'agent-a' }] });
        const cases = [
            {
                name: 'control run recorded as null',
                controlRunText: 'null',
                message: 'control-run.json is not a control run snapshot: the snapshot must be a JSON object.'
            },
            {
                name: 'control run command that is not a control command',
                controlRunText: JSON.stringify({ ...controlRun, commands: [{}] }),
                message: 'control-run.json is not a control run snapshot: commands[0].envelope must be a JSON object.'
            },
            {
                name: 'control run agent without its counters',
                controlRunText: JSON.stringify({
                    ...controlRun,
                    agents: [{ runId: 'run-decoded', agentId: 'agent-a', connected: true }]
                }),
                message: 'control-run.json is not a control run snapshot: agents[0].connectionSequence must be a finite number.'
            }
        ];

        for (const decodeCase of cases) {
            const files = passedRunFiles({ 'control-run.json': decodeCase.controlRunText });
            const analysis = computeDistributedRunAnalysis(files, GENERATED_AT_EPOCH_MS);
            const expectedWarning = { fileName: 'control-run.json', message: decodeCase.message };

            expect(analysis.parseWarnings, decodeCase.name).toEqual([expectedWarning]);
            expect(analysis, decodeCase.name).not.toHaveProperty('performance');
            expect(analysis, decodeCase.name).not.toHaveProperty('spa');
            expect(analysis.summaryMarkdown, decodeCase.name).toContain('Agents: unknown');
            expect(analysis.summaryMarkdown, decodeCase.name).toContain(
                'SPA report and verdict: not analyzed, because they need the control run snapshot that control-run.json records.'
            );
            expect(toDistributedArtifactSnapshots(files, GENERATED_AT_EPOCH_MS).left, decodeCase.name)
                .toEqual(expectedWarning);
            expect(toDistributedArtifactBundle(files, GENERATED_AT_EPOCH_MS).left, decodeCase.name)
                .toEqual(expectedWarning);
        }
    });

    it('keeps optional artifact parse errors visible without hiding the run verdict', () => {
        const analysis = computeDistributedRunAnalysis(
            passedRunFiles({
                'fleet-report.json': '{',
                'events.jsonl': [
                    JSON.stringify({
                        kind: 'runtime',
                        status: 'event',
                        agentId: 'agent-a',
                        atEpochMs: 20,
                        value: { severity: 'info', message: 'loaded' }
                    }),
                    '{not-json'
                ].join('\n')
            }),
            GENERATED_AT_EPOCH_MS
        );

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

    it('skips JSONL rows that are not JSON objects with a warning instead of counting them as evidence', () => {
        const analysis = computeDistributedRunAnalysis(
            passedRunFiles({
                'events.jsonl': [
                    JSON.stringify({
                        kind: 'runtime',
                        status: 'event',
                        agentId: 'agent-a',
                        atEpochMs: 20,
                        value: { severity: 'info', message: 'loaded' }
                    }),
                    '42'
                ].join('\n')
            }),
            GENERATED_AT_EPOCH_MS
        );

        expect(analysis.parseWarnings).toEqual([{
            fileName: 'events.jsonl',
            lineNumber: 2,
            message: 'events.jsonl:2 is not a JSON object.'
        }]);
        expect(analysis.performance?.exportedEventCount).toBe(1);
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
        const analysis = computeDistributedRunAnalysis(filesWithoutManifest, GENERATED_AT_EPOCH_MS);

        expect(bundle.left).toEqual({
            fileName: 'manifest.json',
            message: 'manifest.json is required to form a distributed-run artifact bundle.'
        });
        expect(analysis.parseWarnings).toEqual([bundle.left]);
        expect(analysis.spa?.verdict).toBeDefined();
        const snapshots = toDistributedArtifactSnapshots(filesWithoutManifest, 456).right;
        expect(snapshots?.artifactBundle).toBeUndefined();
        expect(snapshots?.parseWarnings).toEqual([bundle.left]);
    });
});
