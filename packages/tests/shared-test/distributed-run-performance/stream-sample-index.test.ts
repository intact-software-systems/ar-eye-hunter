import { describe, expect, it, vi } from 'vitest';
import type { ControlResultEnvelope } from '../../../shared-test/rallar-bb-test/control-protocol.ts';
import type { DistributedRunStreamTiming } from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    decodeDistributedRunResultEvidence,
    toControlResultEvidence
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis/decode-distributed-run-result-evidence.ts';
import {
    computeStreamTimingSamples,
    type StreamSampleIndexTelemetry
} from '../../../shared-test/rallar-bb-test/distributed-run-performance/compute-stream-timing-samples.ts';
import { computeStreamTiming } from '../../../shared-test/rallar-bb-test/distributed-run-performance/compute-stream-timing.ts';

interface StreamSummaryRow {
    readonly commandId: string;
    readonly plannedFrames: number;
    readonly scheduledFrames: number;
    readonly attemptedFrames: number;
    readonly completedFrames: number;
    readonly failedFrames: number;
    readonly droppedFrames: number;
    readonly inFlightLimitDropCount: number;
    readonly backpressureCount: number;
    readonly pacing: Readonly<{ lateFrameCount: number; }>;
    readonly observations: readonly Readonly<{ durationMs: number; marker: string; }>[];
    readonly thresholdFailures: readonly never[];
}

interface StreamResultRow {
    readonly resultKey?: string;
    readonly agentId: string;
    readonly result: StreamSummaryRow | Readonly<{ results: readonly Readonly<{ resultKey: string; result: StreamSummaryRow; }>[]; }>;
}

interface StreamCandidateSources {
    readonly controlResults?: readonly ControlResultEnvelope[];
    readonly artifactResults?: readonly StreamResultRow[];
}

function completeStreamSummary(
    completedFrames = 1,
    marker = 'same'
): StreamSummaryRow {
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
        pacing: { lateFrameCount: 0 },
        observations: [{ durationMs: completedFrames, marker }],
        thresholdFailures: []
    };
}

function streamResult(identity: string | undefined, summary: StreamSummaryRow): StreamResultRow {
    return {
        ...(identity ? { resultKey: identity } : {}),
        agentId: 'shared-agent',
        result: summary
    };
}

function controlStreamResult(identity: string, summary: StreamSummaryRow): ControlResultEnvelope {
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

function nestedStreamResult(outerIdentity: string, nestedIdentity: string, summary: StreamSummaryRow): StreamResultRow {
    return {
        resultKey: outerIdentity,
        agentId: 'shared-agent',
        result: {
            results: [{ resultKey: nestedIdentity, result: summary }]
        }
    };
}

interface StreamCandidateSelection {
    readonly streamTiming: DistributedRunStreamTiming | undefined;
    readonly telemetry: StreamSampleIndexTelemetry;
}

function computeStreamCandidates(sources: StreamCandidateSources): StreamCandidateSelection {
    const selection = computeStreamTimingSamples({
        controlResults: (sources.controlResults ?? []).map(toControlResultEvidence),
        jsonlResults: (sources.artifactResults ?? []).flatMap((row) => decodeDistributedRunResultEvidence(row) ?? []),
        events: []
    });
    return { streamTiming: computeStreamTiming(selection.samples), telemetry: selection.telemetry };
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
            const { streamTiming } = computeStreamCandidates(collisionCase);
            expect(
                streamTiming?.streamCount,
                collisionCase.name
            ).toBe(collisionCase.expectedStreamCount);
            expect(
                streamTiming?.plannedFrames,
                collisionCase.name
            ).toBe(collisionCase.expectedPlannedFrames);
        }
    });

    it('keeps canonical insertion groups while ordering output by replacement winners', () => {
        const fingerprintA = completeStreamSummary(1, 'fingerprint-a');
        const fingerprintB = completeStreamSummary(2, 'fingerprint-b');

        const { streamTiming, telemetry } = computeStreamCandidates({
            artifactResults: [
                streamResult('identity-a', fingerprintA),
                streamResult('identity-b', fingerprintB),
                streamResult(undefined, fingerprintB),
                streamResult(undefined, fingerprintA)
            ]
        });

        expect(streamTiming).toMatchObject({
            streamCount: 2,
            plannedFrames: 3
        });
        expect(telemetry.replacementCount).toBe(2);
        expect(telemetry.outputGroupOrder).toEqual([
            { insertionIndex: 1, winnerIndex: 2 },
            { insertionIndex: 0, winnerIndex: 3 }
        ]);
    });

    it('accounts exactly for replacement-heavy fingerprint work while lazily invalidating stale groups', () => {
        const lowA = completeStreamSummary(1, 'low-a');
        const lowB = completeStreamSummary(2, 'low-b');
        const highA = completeStreamSummary(4, 'high-a');
        const highB = completeStreamSummary(5, 'high-b');
        const stringify = vi.spyOn(JSON, 'stringify');

        const { streamTiming, telemetry } = computeStreamCandidates({
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
            ]
        });

        const fingerprintStringifyCount = stringify.mock.calls.filter(([value]) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return false;
            }
            return Object.hasOwn(value, 'plannedFrames') &&
                Object.hasOwn(value, 'pacing') &&
                Object.hasOwn(value, 'thresholdFailures') &&
                Object.hasOwn(value, 'observations');
        }).length;
        stringify.mockRestore();

        expect(streamTiming).toMatchObject({
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
        ).toBe(telemetry.fingerprintComputationCount);
    });

    it('reuses the canonical first identity after a cross-source winner changes identity', () => {
        const firstFingerprint = completeStreamSummary(1, 'first-fingerprint');
        const laterFingerprint = completeStreamSummary(2, 'later-fingerprint');

        const { streamTiming } = computeStreamCandidates({
            controlResults: [controlStreamResult('canonical-identity', firstFingerprint)],
            artifactResults: [
                streamResult('replacement-identity', firstFingerprint),
                streamResult('canonical-identity', laterFingerprint)
            ]
        });

        expect(streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 2
        });
    });

    it('bounds indexed equivalence work for adversarial same-base fingerprint collisions', () => {
        const candidateCount = 1_500;
        const sharedFingerprint = completeStreamSummary(1, 'shared-fingerprint');
        const { streamTiming, telemetry } = computeStreamCandidates({
            artifactResults: Array.from(
                { length: candidateCount },
                (_, index) => streamResult(`same-source-identity-${index}`, sharedFingerprint)
            )
        });

        expect(streamTiming).toMatchObject({
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
        expect(telemetry.indexLookupCount).toBe(candidateCount * 4);
        expect(telemetry.equivalenceCheckCount).toBe(0);
        expect(telemetry.indexMaintenanceCount).toBe(candidateCount * 4);
    });
});
