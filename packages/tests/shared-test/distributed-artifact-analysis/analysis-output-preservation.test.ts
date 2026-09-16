import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
    analyzeDistributedRunArtifactFiles,
    deriveDistributedRunSnapshotPerformance,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunArtifactFiles
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { createDistributedArtifactWorkspace } from '../../../shared-test/rallar-bb-test/distributed-artifact-workspace.ts';
import { createRecipeConsoleScaleFixture } from '../../../shared-test/rallar-bb-test/scale-fixture.ts';
import {
    createControlRunSnapshot,
    createDistributedRunSnapshot,
    createQueuedCommandSnapshot,
    createResultEnvelope,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

const GENERATED_AT_EPOCH_MS = 1_700_000_000_000;

// Each digest is the SHA-256 of the output's JSON text, recorded before the analysis owner was renamed and
// split by capability. Replaying these inputs through the analysis as it was before strict decoding produced
// the same text for every output except the failed create request, which that analysis could not recognise.
interface PreservedOutput {
    readonly name: string;
    readonly derive: () => unknown;
    readonly sha256: string;
    readonly bytes: number;
}

function toJsonDigest(value: unknown): { readonly sha256: string; readonly bytes: number; } {
    const text = JSON.stringify(value);
    return { sha256: createHash('sha256').update(text).digest('hex'), bytes: text.length };
}

function createFailedRunFiles(): DistributedRunArtifactFiles {
    return toDistributedRunArtifactFiles({
        distributedRun: createDistributedRunSnapshot({
            distributedRunId: 'dist-preserved-failed',
            controlRunId: 'run-preserved-failed',
            state: 'failed',
            agentIds: ['controller-01', 'controller-02'],
            startedAtEpochMs: 1_000,
            completedAtEpochMs: 4_000,
            commandLinks: [
                { phase: 'start', agentId: 'controller-01', commandId: 'health-a', queuedAtEpochMs: 1_050 },
                { phase: 'start', agentId: 'controller-02', commandId: 'send-rtc', queuedAtEpochMs: 1_100 }
            ],
            summary: { passedParticipants: 1, failedParticipants: 1 },
            failures: [{
                kind: 'participant',
                key: 'controller-02',
                state: 'failed',
                required: true,
                error: { code: 'RTC_NO_ROUTE', message: 'No route to peer.' }
            }]
        }),
        controlRun: createControlRunSnapshot({
            runId: 'run-preserved-failed',
            agents: [
                { agentId: 'controller-01', receivedEventCount: 2 },
                { agentId: 'controller-02', reconnectCount: 1, receivedEventCount: 3 }
            ],
            commands: [
                createQueuedCommandSnapshot({
                    runId: 'run-preserved-failed',
                    agentId: 'controller-01',
                    commandId: 'health-a',
                    queuedAtEpochMs: 1_050,
                    dispatchedAtEpochMs: 1_060,
                    completedAtEpochMs: 1_200
                }),
                createQueuedCommandSnapshot({
                    runId: 'run-preserved-failed',
                    agentId: 'controller-02',
                    commandId: 'send-rtc',
                    command: { kind: 'rtc.send', transport: 'realtime' },
                    queuedAtEpochMs: 1_100,
                    dispatchedAtEpochMs: 1_150,
                    completedAtEpochMs: 2_400
                })
            ],
            results: [
                createResultEnvelope({
                    runId: 'run-preserved-failed',
                    agentId: 'controller-01',
                    commandId: 'health-a',
                    kind: 'health',
                    ok: true,
                    startedAtEpochMs: 1_060,
                    durationMs: 140
                }),
                createResultEnvelope({
                    runId: 'run-preserved-failed',
                    agentId: 'controller-02',
                    commandId: 'send-rtc',
                    kind: 'rtc.send',
                    ok: false,
                    startedAtEpochMs: 1_150,
                    durationMs: 1_250,
                    error: { code: 'RTC_NO_ROUTE', message: 'No route to peer.' }
                })
            ],
            events: [{
                kind: 'diagnostic',
                protocolVersion: 1,
                runId: 'run-preserved-failed',
                agentId: 'controller-02',
                commandId: 'send-rtc',
                eventId: 'diagnostic-no-route',
                atEpochMs: 1_900,
                payload: {
                    diagnosticTypeId: 'rallar.browser.rtc.no_route',
                    severity: 'error',
                    transport: 'realtime',
                    message: 'No RTC route to receiver.'
                }
            }]
        }),
        files: {
            'failures.json': JSON.stringify({
                failures: [{
                    agentId: 'controller-02',
                    commandId: 'send-rtc',
                    error: { code: 'RTC_NO_ROUTE', message: 'No route to peer.' }
                }]
            })
        }
    });
}

function createPassedStreamRunFiles(): DistributedRunArtifactFiles {
    const streamSummary = (agentId: string, completedFrames: number) => ({
        commandId: `stream-${agentId}`,
        transport: 'realtime',
        plannedFrames: 3,
        scheduledFrames: 3,
        attemptedFrames: 3,
        completedFrames,
        failedFrames: 3 - completedFrames,
        droppedFrames: 0,
        backpressureCount: 0,
        pacing: { lateFrameCount: 0 },
        requestedRateHz: 20,
        achievedScheduleHz: 20,
        achievedCompletionHz: 20,
        duration: { minMs: 10, p50Ms: 20, p95Ms: 30, p99Ms: 30, maxMs: 30, averageMs: 20 },
        observations: [
            { index: 0, iteration: 1, durationMs: 10, ok: true },
            { index: 1, iteration: 2, durationMs: 20, ok: true },
            { index: 2, iteration: 3, durationMs: 30, ok: completedFrames === 3 }
        ],
        thresholdFailures: []
    });
    return toDistributedRunArtifactFiles({
        distributedRun: createDistributedRunSnapshot({
            distributedRunId: 'dist-preserved-stream',
            controlRunId: 'run-preserved-stream',
            state: 'passed',
            agentIds: ['controller-01', 'controller-02'],
            startedAtEpochMs: 1_000,
            completedAtEpochMs: 7_000,
            commandLinks: [
                { phase: 'start', agentId: 'controller-01', commandId: 'stream-a', queuedAtEpochMs: 1_000 },
                { phase: 'start', agentId: 'controller-02', commandId: 'stream-b', queuedAtEpochMs: 1_000 }
            ]
        }),
        controlRun: createControlRunSnapshot({
            runId: 'run-preserved-stream',
            agents: [
                { agentId: 'controller-01', receivedEventCount: 30 },
                { agentId: 'controller-02', receivedEventCount: 35 }
            ],
            results: [
                createResultEnvelope({
                    runId: 'run-preserved-stream',
                    agentId: 'controller-01',
                    commandId: 'stream-a',
                    kind: 'rtc.stream',
                    ok: true,
                    startedAtEpochMs: 1_100,
                    durationMs: 3_000,
                    value: streamSummary('controller-01', 3)
                }),
                createResultEnvelope({
                    runId: 'run-preserved-stream',
                    agentId: 'controller-02',
                    commandId: 'stream-b',
                    kind: 'rtc.stream',
                    ok: true,
                    startedAtEpochMs: 1_100,
                    durationMs: 3_500,
                    value: streamSummary('controller-02', 2)
                })
            ]
        }),
        files: {
            'events.jsonl': [
                JSON.stringify({
                    kind: 'runtime',
                    name: 'slow-route',
                    status: 'diagnostic',
                    agentId: 'controller-02',
                    atEpochMs: 2_000,
                    value: { severity: 'warning', message: 'slow route' }
                })
            ].join('\n')
        }
    });
}

function createGroupAssertionRunFiles(): DistributedRunArtifactFiles {
    return toDistributedRunArtifactFiles({
        distributedRun: createDistributedRunSnapshot({
            distributedRunId: 'dist-preserved-group',
            controlRunId: 'run-preserved-group',
            state: 'failed',
            agentIds: ['agent-a', 'agent-b'],
            startedAtEpochMs: 1,
            completedAtEpochMs: 5,
            summary: { groupAssertions: 1, failedGroupAssertions: 1 },
            failures: [{
                kind: 'group-assertion',
                key: 'members-converge',
                state: 'failed',
                required: true,
                error: {
                    code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
                    message: 'Group assertion members-converge failed: 2 distinct values across 2 participants.'
                }
            }]
        }),
        controlRun: createControlRunSnapshot({ runId: 'run-preserved-group' })
    });
}

function createFailedCreateRequestFiles(): DistributedRunArtifactFiles {
    return {
        'runner-summary.json': JSON.stringify({
            distributedRunId: 'dist-preserved-create',
            controlRunId: 'run-preserved-create',
            state: 'failed',
            ok: false,
            artifactDir: '/artifacts/dist-preserved-create'
        }),
        'control-post-create-error.json': '{"error":"bad manifest","message":"target policy rejected"}',
        'control-post-error-metadata.json': JSON.stringify({
            phase: 'create',
            method: 'POST',
            path: '/distributed-runs',
            httpStatus: '400',
            curlStatus: 0,
            exitStatus: 22,
            responseFile: 'control-post-create-error.json',
            atEpochSeconds: 1_700_000_000
        })
    };
}

const PRESERVED_OUTPUTS: readonly PreservedOutput[] = [
    {
        name: 'failed run analysis with command, diagnostic and failure evidence',
        derive: () => analyzeDistributedRunArtifactFiles({ files: createFailedRunFiles(), generatedAtEpochMs: GENERATED_AT_EPOCH_MS }).right,
        sha256: '80e14d6cd408e61d52af605306eb3e316b785ecd54cce015ebcb403c91b9ef66',
        bytes: 7_282
    },
    {
        name: 'passed stream run analysis',
        derive: () => analyzeDistributedRunArtifactFiles({ files: createPassedStreamRunFiles(), generatedAtEpochMs: GENERATED_AT_EPOCH_MS }).right,
        sha256: 'c8adbd8e7f94910fa0c595dfe66209247799aa38d0b807bbc63d805584a2b3e5',
        bytes: 4_850
    },
    {
        name: 'group assertion failure analysis',
        derive: () =>
            analyzeDistributedRunArtifactFiles({ files: createGroupAssertionRunFiles(), generatedAtEpochMs: GENERATED_AT_EPOCH_MS })
                .right,
        sha256: '45d3fe3b0b6c3c35ede1c395833f817fa50e6fc0111362fe33f9ecf6466a3b2b',
        bytes: 6_743
    },
    {
        name: 'failed create request analysis',
        derive: () =>
            analyzeDistributedRunArtifactFiles({ files: createFailedCreateRequestFiles(), generatedAtEpochMs: GENERATED_AT_EPOCH_MS })
                .right,
        sha256: '2ac57c4ab4bf2ce5001b38ec42553558ac08c7f1ce87d8603bd915cb9af8fbff',
        bytes: 1_898
    },
    {
        name: 'stream run bundle',
        derive: () => distributedArtifactBundleFromFiles(createPassedStreamRunFiles(), GENERATED_AT_EPOCH_MS).right,
        sha256: '2a2fe82f894e3da781415d6e11974af84ccba332ed658a8ead70d12214f64c80',
        bytes: 4_925
    },
    {
        name: 'stream run snapshot performance',
        derive: () => {
            const snapshots = distributedArtifactSnapshotsFromFiles(createPassedStreamRunFiles(), GENERATED_AT_EPOCH_MS).right;
            return snapshots === undefined ? undefined : deriveDistributedRunSnapshotPerformance({
                distributedRun: snapshots.distributedRun,
                controlRun: snapshots.controlRun
            });
        },
        sha256: '38cb5882d810f903d422ae2ca50b3de6f6f1509bef1388f09fd4addaae2e6425',
        bytes: 1_305
    },
    {
        name: 'failed run workspace',
        derive: () => createDistributedArtifactWorkspace({ files: createFailedRunFiles(), generatedAtEpochMs: GENERATED_AT_EPOCH_MS }),
        sha256: 'eb89d668d1888cc846a2a215e9f1517aaaed1ba25bf567c161c669f8a5f7961f',
        bytes: 27_304
    },
    {
        name: 'scale fixture workspace analysis',
        derive: () => {
            const fixture = createRecipeConsoleScaleFixture();
            return createDistributedArtifactWorkspace({
                files: fixture.files,
                generatedAtEpochMs: fixture.generatedAtEpochMs,
                artifactSchemaVersion: fixture.artifactSchemaVersion
            }).analysis;
        },
        sha256: 'faeed2c5a8ac527ab1f308b93e07f33406ca7819f444e0e9e49e737bce7e88bd',
        bytes: 261_827
    }
];

describe('distributed run artifact analysis output preservation', () => {
    it.each(PRESERVED_OUTPUTS)('derives the recorded $name', ({ derive, sha256, bytes }) => {
        expect(toJsonDigest(derive())).toEqual({ sha256, bytes });
    });
});
