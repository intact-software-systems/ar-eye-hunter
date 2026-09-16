import { describe, expect, it, vi } from 'vitest';
import type { ControlResultEnvelope } from '../../../shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../../../shared-test/rallar-bb-test/control-snapshots.ts';
import {
    computeDistributedRunSnapshotPerformance,
    type StreamSampleIndexTelemetry
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

function completeStreamSummary(
    completedFrames = 1,
    marker = 'same'
): Record<string, unknown> {
    return {
        commandId: 'shared-stream-command',
        plannedFrames: completedFrames,
        scheduledFrames: completedFrames,
        attemptedFrames: completedFrames,
        completedFrames,
        failedFrames: 0,
        droppedFrames: 0,
        inFlightLimitDropCount: 0,
        backpressureCount: 0,
        observations: [{ durationMs: completedFrames, marker }],
        thresholdFailures: []
    };
}

function streamResult(
    identity: string | undefined,
    summary: Record<string, unknown>
): Record<string, unknown> {
    return {
        ...(identity ? { resultKey: identity } : {}),
        agentId: 'shared-agent',
        result: summary
    };
}

function controlStreamResult(
    identity: string,
    summary: Record<string, unknown>
): ControlResultEnvelope {
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: 'run-stream-equivalence',
        agentId: 'shared-agent',
        commandId: identity,
        ok: true,
        result: {
            commandId: identity,
            kind: 'rtc.stream',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 0,
            endedAtEpochMs: 1,
            durationMs: 1,
            value: summary
        }
    };
}

function nestedStreamResult(
    outerIdentity: string,
    nestedIdentity: string,
    summary: Record<string, unknown>
): Record<string, unknown> {
    return {
        resultKey: outerIdentity,
        agentId: 'shared-agent',
        result: {
            results: [{ resultKey: nestedIdentity, result: summary }]
        }
    };
}

function deriveStreamCandidatePerformance(
    input: Readonly<{
        controlResults?: readonly ControlResultEnvelope[];
        artifactResults?: readonly Record<string, unknown>[];
        onStreamSampleIndexTelemetry?: (telemetry: StreamSampleIndexTelemetry) => void;
    }>
) {
    return computeDistributedRunSnapshotPerformance({
        distributedRun: {
            distributedRunId: 'dist-stream-equivalence',
            controlRunId: 'run-stream-equivalence',
            manifest: {
                distributedRunId: 'dist-stream-equivalence',
                controlRunId: 'run-stream-equivalence',
                group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'bb-group' },
                recipes: [],
                targetPolicy: { mode: 'selected-agents', agentIds: ['shared-agent'] }
            },
            state: 'passed',
            createdAtEpochMs: 0,
            updatedAtEpochMs: 1,
            targetAgentIds: ['shared-agent'],
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
            runId: 'run-stream-equivalence',
            createdAtEpochMs: 0,
            updatedAtEpochMs: 1,
            agents: [{
                runId: 'run-stream-equivalence',
                agentId: 'shared-agent',
                connected: true,
                connectionSequence: 1,
                reconnectCount: 0,
                receivedResultCount: 0,
                receivedEventCount: 0,
                completedCommandIds: [],
                resumeCompletedCommandIds: []
            }],
            commands: [],
            results: input.controlResults ?? [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: []
        } satisfies ControlRunSnapshot,
        artifactResults: input.artifactResults ?? [],
        artifactEvents: [],
        onStreamSampleIndexTelemetry: input.onStreamSampleIndexTelemetry
    });
}

describe('distributed run artifact stream sample index', () => {
    it('preserves the stream execution equivalence collision matrix', () => {
        const sameFingerprint = completeStreamSummary(1, 'same');
        const differentFingerprint = completeStreamSummary(2, 'different');
        const cases = [
            {
                name: 'exact identities match without fingerprint equality',
                artifactResults: [
                    streamResult('same-identity', sameFingerprint),
                    streamResult('same-identity', differentFingerprint)
                ],
                expectedStreamCount: 1,
                expectedPlannedFrames: 2
            },
            {
                name: 'identityless samples match without fingerprint equality',
                artifactResults: [
                    streamResult(undefined, sameFingerprint),
                    streamResult(undefined, differentFingerprint)
                ],
                expectedStreamCount: 1,
                expectedPlannedFrames: 2
            },
            {
                name: 'different nested identities do not match despite equal fingerprints',
                artifactResults: [
                    nestedStreamResult('outer-a', 'leaf-a', sameFingerprint),
                    nestedStreamResult('outer-b', 'leaf-b', sameFingerprint)
                ],
                expectedStreamCount: 2,
                expectedPlannedFrames: 2
            },
            {
                name: 'same-source nonnested identities do not match despite equal fingerprints',
                artifactResults: [
                    streamResult('identity-a', sameFingerprint),
                    streamResult('identity-b', sameFingerprint)
                ],
                expectedStreamCount: 2,
                expectedPlannedFrames: 2
            },
            {
                name: 'cross-source nonnested identities match equal fingerprints',
                controlResults: [controlStreamResult('control-identity', sameFingerprint)],
                artifactResults: [streamResult('artifact-identity', sameFingerprint)],
                expectedStreamCount: 1,
                expectedPlannedFrames: 1
            },
            {
                name: 'cross-source nonnested identities retain different fingerprints',
                controlResults: [controlStreamResult('control-identity', sameFingerprint)],
                artifactResults: [streamResult('artifact-identity', differentFingerprint)],
                expectedStreamCount: 2,
                expectedPlannedFrames: 3
            },
            {
                name: 'nested and nonnested identities match equal fingerprints',
                artifactResults: [
                    streamResult('root-identity', sameFingerprint),
                    nestedStreamResult('outer-identity', 'leaf-identity', sameFingerprint)
                ],
                expectedStreamCount: 1,
                expectedPlannedFrames: 1
            },
            {
                name: 'identityless and identified samples match equal fingerprints',
                artifactResults: [
                    streamResult('identified', sameFingerprint),
                    streamResult(undefined, sameFingerprint)
                ],
                expectedStreamCount: 1,
                expectedPlannedFrames: 1
            },
            {
                name: 'identityless and identified samples retain different fingerprints',
                artifactResults: [
                    streamResult('identified', sameFingerprint),
                    streamResult(undefined, differentFingerprint)
                ],
                expectedStreamCount: 2,
                expectedPlannedFrames: 3
            }
        ] as const;

        for (const collisionCase of cases) {
            const performance = deriveStreamCandidatePerformance(collisionCase);
            expect(
                performance.streamTiming?.streamCount,
                collisionCase.name
            ).toBe(collisionCase.expectedStreamCount);
            expect(
                performance.streamTiming?.plannedFrames,
                collisionCase.name
            ).toBe(collisionCase.expectedPlannedFrames);
        }
    });

    it('keeps canonical insertion groups while ordering output by replacement winners', () => {
        let telemetry: StreamSampleIndexTelemetry | undefined;
        const fingerprintA = completeStreamSummary(1, 'fingerprint-a');
        const fingerprintB = completeStreamSummary(2, 'fingerprint-b');

        const performance = deriveStreamCandidatePerformance({
            artifactResults: [
                streamResult('identity-a', fingerprintA),
                streamResult('identity-b', fingerprintB),
                streamResult(undefined, fingerprintB),
                streamResult(undefined, fingerprintA)
            ],
            onStreamSampleIndexTelemetry: (value) => {
                telemetry = value;
            }
        });

        expect(performance.streamTiming).toMatchObject({
            streamCount: 2,
            plannedFrames: 3
        });
        expect(telemetry?.replacementCount).toBe(2);
        expect(telemetry?.outputGroupOrder).toEqual([
            { insertionIndex: 1, winnerIndex: 2 },
            { insertionIndex: 0, winnerIndex: 3 }
        ]);
    });

    it('accounts exactly for replacement-heavy fingerprint work while lazily invalidating stale groups', () => {
        const lowA = completeStreamSummary(1, 'low-a');
        const lowB = completeStreamSummary(2, 'low-b');
        const highA = completeStreamSummary(4, 'high-a');
        const highB = completeStreamSummary(5, 'high-b');
        let telemetry: StreamSampleIndexTelemetry | undefined;
        const stringify = vi.spyOn(JSON, 'stringify');

        const performance = deriveStreamCandidatePerformance({
            controlResults: [
                controlStreamResult('identity-a', lowA),
                controlStreamResult('identity-b', lowB)
            ],
            artifactResults: [
                streamResult('identity-a', highA),
                streamResult('identity-b', highB),
                streamResult(undefined, lowA),
                streamResult(undefined, highA),
                streamResult('identity-c', highA),
                nestedStreamResult('outer', 'leaf', highA),
                streamResult(undefined, highA)
            ],
            onStreamSampleIndexTelemetry: (value) => {
                telemetry = value;
            }
        });

        const fingerprintStringifyCount = stringify.mock.calls.filter(([value]) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return false;
            }
            const record = value as Record<string, unknown>;
            return Object.hasOwn(record, 'plannedFrames') &&
                Object.hasOwn(record, 'pacing') &&
                Object.hasOwn(record, 'thresholdFailures') &&
                Object.hasOwn(record, 'observations');
        }).length;
        stringify.mockRestore();

        expect(performance.streamTiming).toMatchObject({
            streamCount: 3,
            plannedFrames: 10
        });
        expect(telemetry).toEqual({
            candidateCount: 9,
            baseKeyLookupCount: 9,
            fingerprintComputationCount: 9,
            indexLookupCount: 27,
            equivalenceCheckCount: 8,
            indexMaintenanceCount: 34,
            groupCount: 3,
            replacementCount: 6,
            outputGroupOrder: [
                { insertionIndex: 1, winnerIndex: 3 },
                { insertionIndex: 4, winnerIndex: 4 },
                { insertionIndex: 0, winnerIndex: 8 }
            ]
        });
        expect(
            fingerprintStringifyCount,
            `telemetry: ${JSON.stringify(telemetry)}`
        ).toBe(telemetry?.fingerprintComputationCount);
    });

    it('reuses the canonical first identity after a cross-source winner changes identity', () => {
        const firstFingerprint = completeStreamSummary(1, 'first-fingerprint');
        const laterFingerprint = completeStreamSummary(2, 'later-fingerprint');

        const performance = deriveStreamCandidatePerformance({
            controlResults: [controlStreamResult('canonical-identity', firstFingerprint)],
            artifactResults: [
                streamResult('replacement-identity', firstFingerprint),
                streamResult('canonical-identity', laterFingerprint)
            ]
        });

        expect(performance.streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 2
        });
    });

    it('bounds indexed equivalence work for adversarial same-base fingerprint collisions', () => {
        const candidateCount = 1_500;
        const sharedFingerprint = completeStreamSummary(1, 'shared-fingerprint');
        let telemetry: StreamSampleIndexTelemetry | undefined;

        const performance = deriveStreamCandidatePerformance({
            artifactResults: Array.from({ length: candidateCount }, (_, index) => streamResult(`same-source-identity-${index}`, sharedFingerprint)),
            onStreamSampleIndexTelemetry: (value) => {
                telemetry = value;
            }
        });

        expect(performance.streamTiming).toMatchObject({
            streamCount: candidateCount,
            plannedFrames: candidateCount
        });
        expect(telemetry).toMatchObject({
            candidateCount,
            baseKeyLookupCount: candidateCount,
            fingerprintComputationCount: candidateCount,
            groupCount: candidateCount,
            replacementCount: 0
        });
        expect(telemetry?.indexLookupCount).toBe(candidateCount * 4);
        expect(telemetry?.equivalenceCheckCount).toBe(0);
        expect(telemetry?.indexMaintenanceCount).toBe(candidateCount * 4);
    });
});
