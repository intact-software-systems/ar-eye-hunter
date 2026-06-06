import { describe, expect, it } from 'vitest';
import {
    RallarMotion,
    classifyRallarMotionDiscontinuity,
    createRallarMotionAdaptiveDelay,
    createRallarMotionBuffer,
    createRallarMotionCorrectionBlender,
    createRallarMotionDiagnosticsTracker,
    createRallarMotionKinematicsEstimator,
    createRallarMotionSendGate,
    deadReckonRallarMotion,
    dequantizeRallarMotionVec3,
    estimateRallarMotionAcceleration,
    estimateRallarMotionVelocity,
    interpolateRallarMotion,
    interpolateRallarMotionHermite,
    quantizeRallarMotionVec3,
    roundRallarMotionVec3,
    shouldSendRallarMotionSample,
    shouldSendRallarMotionUpdate,
    shortestRallarMotionAngleDelta,
    smoothRallarMotionVec3,
    type RallarMotionSample,
    type RallarMotionVec3,
} from '@shared/rallar-motion/mod.ts';

describe('Rallar Motion', () => {
    it('interpolates between bracketing samples', () => {
        const buffer = createRallarMotionBuffer<{ label: string }>({
            interpolationDelayMs: 0,
        });

        expect(buffer.push(sample('player-1', 1_000, [0, 0, 0], {
            seq: 1,
            metadata: { label: 'old' },
        })).status).toBe('accepted');
        expect(buffer.push(sample('player-1', 1_100, [10, 0, 0], {
            seq: 2,
            metadata: { label: 'new' },
        })).status).toBe('accepted');

        const estimate = buffer.sample('player-1', 1_050);

        expect(estimate?.mode).toBe('interpolated');
        expect(estimate?.sourceSeq).toBe(1);
        expect(estimate?.targetSeq).toBe(2);
        expect(estimate?.metadata).toEqual({ label: 'new' });
        expectVecClose(estimate?.position, [5, 0, 0]);
    });

    it('dead reckons with velocity while inside the extrapolation window', () => {
        const estimate = deadReckonRallarMotion(
            sample('player-1', 1_000, [1, 2, 3], {
                velocity: [2, 4, 6],
                rotation: [0, 1, 2],
                angularVelocity: [1, 0, -1],
            }),
            1_250,
            500,
        );

        expect(estimate.mode).toBe('extrapolated');
        expect(estimate.extrapolationMs).toBe(250);
        expectVecClose(estimate.position, [1.5, 3, 4.5]);
        expectVecClose(estimate.rotation, [0.25, 1, 1.75]);
    });

    it('holds the latest pose after extrapolation expires', () => {
        const estimate = deadReckonRallarMotion(
            sample('player-1', 1_000, [1, 2, 3], {
                velocity: [10, 10, 10],
                rotation: [0, 1, 2],
                angularVelocity: [10, 10, 10],
            }),
            1_300,
            150,
        );

        expect(estimate.mode).toBe('held');
        expect(estimate.extrapolationMs).toBe(0);
        expect(estimate.ageMs).toBe(300);
        expectVecClose(estimate.position, [1, 2, 3]);
        expectVecClose(estimate.rotation, [0, 1, 2]);
    });

    it('rejects stale and duplicate sequenced samples', () => {
        const buffer = createRallarMotionBuffer();

        expect(buffer.push(sample('player-1', 1_100, [1, 0, 0], { seq: 2 })))
            .toMatchObject({ status: 'accepted', sampleCount: 1 });
        expect(buffer.push(sample('player-1', 1_101, [2, 0, 0], { seq: 2 })))
            .toMatchObject({ status: 'duplicate-seq', sampleCount: 1 });
        expect(buffer.push(sample('player-1', 1_000, [0, 0, 0], { seq: 1 })))
            .toMatchObject({ status: 'stale-seq', sampleCount: 1 });
    });

    it('sorts unsequenced samples by receiver-observed time', () => {
        const buffer = createRallarMotionBuffer({ interpolationDelayMs: 0 });

        buffer.push(sample('player-1', 1_100, [10, 0, 0]));
        buffer.push(sample('player-1', 1_000, [0, 0, 0]));

        const estimate = buffer.sample('player-1', 1_050);

        expect(estimate?.mode).toBe('interpolated');
        expectVecClose(estimate?.position, [5, 0, 0]);
    });

    it('preserves metadata from the newest contributing sample', () => {
        const estimate = interpolateRallarMotion(
            sample('player-1', 1_000, [0, 0, 0], {
                metadata: { score: 1 },
            }),
            sample('player-1', 1_100, [10, 0, 0], {
                metadata: { score: 2 },
            }),
            1_050,
        );

        expect(estimate.metadata).toEqual({ score: 2 });
    });

    it('prunes by age and max sample count', () => {
        const buffer = createRallarMotionBuffer({
            interpolationDelayMs: 0,
            maxSamplesPerEntity: 2,
            maxSampleAgeMs: 100,
        });

        buffer.push(sample('player-1', 1_000, [0, 0, 0]));
        buffer.push(sample('player-1', 1_100, [10, 0, 0]));
        const newest = buffer.push(sample('player-1', 1_200, [20, 0, 0]));

        expect(newest).toMatchObject({
            status: 'accepted',
            sampleCount: 2,
            droppedSampleCount: 1,
        });
        expect(buffer.push(sample('player-1', 900, [-10, 0, 0]))).toMatchObject({
            status: 'dropped-old-sample',
            sampleCount: 2,
        });

        expect(buffer.prune(1_250)).toBe(1);
        expect(buffer.entityIds()).toEqual(['player-1']);
        expect(buffer.prune(1_301)).toBe(1);
        expect(buffer.entityIds()).toEqual([]);
    });

    it('removes entities and samples all retained tracks', () => {
        const buffer = createRallarMotionBuffer({ interpolationDelayMs: 0 });

        buffer.push(sample('player-1', 1_000, [1, 0, 0]));
        buffer.push(sample('player-2', 1_000, [2, 0, 0]));

        expect(buffer.sampleAll(1_000).size).toBe(2);
        expect(buffer.remove('player-1')).toBe(true);
        expect(buffer.remove('player-1')).toBe(false);
        expect([...buffer.sampleAll(1_000).keys()]).toEqual(['player-2']);
    });

    it('estimates velocity from observed sample times', () => {
        const velocity = estimateRallarMotionVelocity(
            sample('player-1', 1_000, [0, 0, 0]),
            sample('player-1', 1_250, [1, 2, 3]),
        );

        expectVecClose(velocity, [4, 8, 12]);
        expect(estimateRallarMotionVelocity(
            sample('player-1', 1_000, [0, 0, 0]),
            sample('player-1', 1_000, [1, 2, 3]),
        )).toBeUndefined();
    });

    it('checks send cadence using the caller-owned budget', () => {
        expect(shouldSendRallarMotionSample(1_000, 1_050, 50)).toBe(false);
        expect(shouldSendRallarMotionSample(1_050, 1_050, 50)).toBe(true);
        expect(shouldSendRallarMotionSample(1_000, 1_050, 0)).toBe(true);
    });

    it('ignores sender clock metadata when sampling', () => {
        const buffer = createRallarMotionBuffer<{ sentAtEpochMs: number }>({
            interpolationDelayMs: 0,
        });

        buffer.push(sample('player-1', 1_000, [0, 0, 0], {
            metadata: { sentAtEpochMs: 10_000 },
        }));
        buffer.push(sample('player-1', 1_100, [10, 0, 0], {
            metadata: { sentAtEpochMs: 10 },
        }));

        const estimate = buffer.sample('player-1', 1_050);

        expect(estimate?.mode).toBe('interpolated');
        expect(estimate?.metadata).toEqual({ sentAtEpochMs: 10 });
        expectVecClose(estimate?.position, [5, 0, 0]);
    });

    it('exposes the toolkit facade as aliases for named helpers', () => {
        expect(RallarMotion.createBuffer).toBe(createRallarMotionBuffer);
        expect(RallarMotion.createAdaptiveDelay).toBe(createRallarMotionAdaptiveDelay);
        expect(RallarMotion.createCorrectionBlender).toBe(
            createRallarMotionCorrectionBlender,
        );
        expect(RallarMotion.createKinematicsEstimator).toBe(
            createRallarMotionKinematicsEstimator,
        );
        expect(RallarMotion.createSendGate).toBe(createRallarMotionSendGate);
        expect(RallarMotion.interpolate).toBe(interpolateRallarMotion);
        expect(RallarMotion.interpolateHermite).toBe(interpolateRallarMotionHermite);
        expect(RallarMotion.deadReckon).toBe(deadReckonRallarMotion);
        expect(RallarMotion.classifyDiscontinuity).toBe(
            classifyRallarMotionDiscontinuity,
        );
        expect(RallarMotion.estimateVelocity).toBe(estimateRallarMotionVelocity);
        expect(RallarMotion.estimateAcceleration).toBe(
            estimateRallarMotionAcceleration,
        );
        expect(RallarMotion.shouldSendSample).toBe(shouldSendRallarMotionSample);
        expect(RallarMotion.shouldSendUpdate).toBe(shouldSendRallarMotionUpdate);
        expect(RallarMotion.quantizeVec3).toBe(quantizeRallarMotionVec3);
        expect(RallarMotion.dequantizeVec3).toBe(dequantizeRallarMotionVec3);
        expect(RallarMotion.roundVec3).toBe(roundRallarMotionVec3);
    });

    it('uses dynamic interpolation delay without recreating the buffer', () => {
        let delayMs = 100;
        const buffer = createRallarMotionBuffer({
            readInterpolationDelayMs: () => delayMs,
        });

        buffer.push(sample('player-1', 1_000, [0, 0, 0]));
        buffer.push(sample('player-1', 1_100, [10, 0, 0]));

        expectVecClose(buffer.sample('player-1', 1_150)?.position, [5, 0, 0]);

        delayMs = 50;
        expectVecClose(buffer.sample('player-1', 1_150)?.position, [10, 0, 0]);
    });

    it('interpolates with Hermite curves and falls back to linear', () => {
        const curved = interpolateRallarMotionHermite(
            sample('player-1', 1_000, [0, 0, 0], {
                velocity: [0, 0, 0],
            }),
            sample('player-1', 2_000, [10, 0, 0], {
                velocity: [0, 0, 0],
            }),
            1_250,
        );
        const fallback = interpolateRallarMotionHermite(
            sample('player-1', 1_000, [0, 0, 0]),
            sample('player-1', 2_000, [10, 0, 0]),
            1_250,
        );

        expectVecClose(curved.position, [1.5625, 0, 0]);
        expectVecClose(fallback.position, [2.5, 0, 0]);
    });

    it('wraps Euler interpolation along the shortest angle path', () => {
        const estimate = interpolateRallarMotion(
            sample('player-1', 1_000, [0, 0, 0], {
                rotation: [350, 0, 0],
            }),
            sample('player-1', 2_000, [0, 0, 0], {
                rotation: [10, 0, 0],
            }),
            1_500,
            { rotationWrap: { period: 360 } },
        );

        expect(shortestRallarMotionAngleDelta(350, 10, 360)).toBe(20);
        expectVecClose(estimate.rotation, [0, 0, 0]);
    });

    it('holds across detected discontinuities instead of interpolating through space', () => {
        const buffer = createRallarMotionBuffer({
            interpolationDelayMs: 0,
            discontinuity: {
                enabled: true,
                maxPositionDelta: 5,
            },
        });

        buffer.push(sample('player-1', 1_000, [0, 0, 0]));
        buffer.push(sample('player-1', 1_100, [100, 0, 0]));

        const beforeSnap = buffer.sample('player-1', 1_050);
        const atSnap = buffer.sample('player-1', 1_100);

        expect(beforeSnap?.mode).toBe('held');
        expectVecClose(beforeSnap?.position, [0, 0, 0]);
        expect(atSnap?.mode).toBe('held');
        expectVecClose(atSnap?.position, [100, 0, 0]);
    });

    it('classifies discontinuities by distance, rotation, and speed', () => {
        expect(classifyRallarMotionDiscontinuity(
            sample('player-1', 1_000, [0, 0, 0]),
            sample('player-1', 1_100, [100, 0, 0]),
            { maxPositionDelta: 10 },
        )).toMatchObject({
            discontinuous: true,
            reason: 'position-distance',
        });
        expect(classifyRallarMotionDiscontinuity(
            sample('player-1', 1_000, [0, 0, 0]),
            sample('player-1', 1_100, [2, 0, 0]),
            { maxSpeed: 10 },
        )).toMatchObject({
            discontinuous: true,
            reason: 'speed',
        });
        expect(classifyRallarMotionDiscontinuity(
            sample('player-1', 1_000, [0, 0, 0], { rotation: [0, 0, 0] }),
            sample('player-1', 1_100, [0, 0, 0], { rotation: [90, 0, 0] }),
            { maxRotationDelta: 45 },
        )).toMatchObject({
            discontinuous: true,
            reason: 'rotation-distance',
        });
    });

    it('blends small corrections and snaps large corrections', () => {
        const blender = createRallarMotionCorrectionBlender({
            blendDurationMs: 100,
            snapPositionDelta: 10,
        });

        expect(blender.correct({
            current: { position: [0, 0, 0] },
            target: { position: [4, 0, 0] },
            nowEpochMs: 1_000,
        })).toMatchObject({
            mode: 'blending',
            progress: 0,
        });
        expectVecClose(blender.sample(1_050)?.position, [2, 0, 0]);
        expect(blender.sample(1_100)).toMatchObject({
            mode: 'settled',
            progress: 1,
        });

        const snapped = blender.correct({
            current: { position: [0, 0, 0] },
            target: { position: [20, 0, 0] },
            nowEpochMs: 1_200,
        });

        expect(snapped.mode).toBe('snapped');
        expectVecClose(snapped.position, [20, 0, 0]);
    });

    it('reports confidence while interpolating, extrapolating, and holding', () => {
        const extrapolated = deadReckonRallarMotion(
            sample('player-1', 1_000, [0, 0, 0], {
                velocity: [10, 0, 0],
            }),
            1_050,
            100,
        );
        const expired = deadReckonRallarMotion(
            sample('player-1', 1_000, [0, 0, 0], {
                velocity: [10, 0, 0],
            }),
            1_200,
            100,
        );
        const buffer = createRallarMotionBuffer({ interpolationDelayMs: 0 });
        buffer.push(sample('player-1', 1_000, [0, 0, 0]));

        expect(interpolateRallarMotion(
            sample('player-1', 1_000, [0, 0, 0]),
            sample('player-1', 1_100, [10, 0, 0]),
            1_050,
        ).confidence).toBe(1);
        expect(extrapolated.confidence).toBeCloseTo(0.5, 6);
        expect(expired.confidence).toBe(0);
        expect(buffer.sample('player-1', 900)?.confidence).toBe(1);
    });

    it('gates sending by cadence, thresholds, idle cadence, and force-send', () => {
        const gate = createRallarMotionSendGate({
            cadenceMs: 50,
            idleCadenceMs: 250,
            minPositionDelta: 1,
        });

        const initial = gate.check({ position: [0, 0, 0] }, 1_000);
        expect(initial).toMatchObject({ shouldSend: true, reason: 'initial' });
        gate.recordSent({ position: [0, 0, 0] }, 1_000);

        expect(gate.check({ position: [2, 0, 0] }, 1_030)).toMatchObject({
            shouldSend: false,
            reason: 'waiting',
        });
        expect(gate.check({ position: [2, 0, 0] }, 1_050)).toMatchObject({
            shouldSend: true,
            reason: 'position',
        });
        gate.recordSent({ position: [2, 0, 0] }, 1_050);

        expect(gate.check({ position: [2, 0, 0] }, 1_300)).toMatchObject({
            shouldSend: true,
            reason: 'idle',
        });

        expect(shouldSendRallarMotionUpdate({
            nowEpochMs: 2_000,
            lastSentAtEpochMs: 1_000,
            lastSentSample: { position: [0, 0, 0] },
            nextSample: { position: [0, 0, 0] },
            forceSendAfterMs: 500,
        })).toMatchObject({
            shouldSend: true,
            reason: 'force',
        });
    });

    it('estimates and smooths kinematics from receiver-local samples', () => {
        const estimator = createRallarMotionKinematicsEstimator({
            smoothingAlpha: 0.5,
            rotationWrap: { period: 360 },
        });

        expect(estimator.push({
            entityId: 'player-1',
            observedAtEpochMs: 1_000,
            position: [0, 0, 0],
            rotation: [350, 0, 0],
        }).velocity).toBeUndefined();

        const second = estimator.push({
            entityId: 'player-1',
            observedAtEpochMs: 1_100,
            position: [10, 0, 0],
            rotation: [10, 0, 0],
        });
        const third = estimator.push({
            entityId: 'player-1',
            observedAtEpochMs: 1_200,
            position: [30, 0, 0],
            rotation: [30, 0, 0],
        });

        expectVecClose(second.velocity, [100, 0, 0]);
        expectVecClose(second.angularVelocity, [200, 0, 0]);
        expectVecClose(third.velocity, [150, 0, 0]);
        expectVecClose(third.acceleration, [500, 0, 0]);
        expectVecClose(
            estimateRallarMotionAcceleration(
                sample('player-1', 1_000, [0, 0, 0], { velocity: [0, 0, 0] }),
                sample('player-1', 2_000, [0, 0, 0], { velocity: [10, 0, 0] }),
            ),
            [10, 0, 0],
        );
        expectVecClose(smoothRallarMotionVec3([0, 0, 0], [10, 0, 0], 0.25), [
            2.5,
            0,
            0,
        ]);
    });

    it('tracks sequence gaps and observed interval diagnostics', () => {
        const buffer = createRallarMotionBuffer();
        const diagnostics = createRallarMotionDiagnosticsTracker();

        const first = sample('player-1', 1_000, [0, 0, 0], { seq: 1 });
        const gap = sample('player-1', 1_050, [1, 0, 0], { seq: 4 });
        diagnostics.recordPush(buffer.push(first), first);
        const gapResult = buffer.push(gap);
        const summary = diagnostics.recordPush(gapResult, gap);

        expect(gapResult.sequenceGap).toEqual({
            previousSeq: 1,
            seq: 4,
            droppedSeqCount: 2,
        });
        expect(summary).toMatchObject({
            acceptedCount: 2,
            sequenceGapCount: 1,
            droppedSequenceCount: 2,
            intervalCount: 1,
            averageIntervalMs: 50,
        });

        diagnostics.recordPush(buffer.push(sample('player-1', 1_060, [2, 0, 0], {
            seq: 4,
        })));
        diagnostics.recordPush(buffer.push(sample('player-1', 1_040, [2, 0, 0], {
            seq: 3,
        })));

        expect(diagnostics.summary()).toMatchObject({
            duplicateSeqCount: 1,
            staleSeqCount: 1,
        });
    });

    it('adapts interpolation delay from observed jitter', () => {
        const delay = createRallarMotionAdaptiveDelay({
            defaultDelayMs: 100,
            minDelayMs: 20,
            maxDelayMs: 200,
            smoothingAlpha: 1,
            jitterMultiplier: 1,
            safetyMarginMs: 5,
        });

        expect(delay.currentDelayMs()).toBe(100);
        delay.pushObservedAt(1_000);
        expect(delay.pushObservedAt(1_050)).toBe(55);
        expect(delay.pushObservedAt(1_150)).toBe(155);
    });

    it('rounds, quantizes, and dequantizes vectors with caller-owned ranges', () => {
        expect(roundRallarMotionVec3([1.2345, -1.2355, 0], 2)).toEqual([
            1.23,
            -1.24,
            0,
        ]);

        const quantized = quantizeRallarMotionVec3([5, 0, -5], {
            min: -10,
            max: 10,
            steps: 20,
        });

        expect(quantized).toEqual([15, 10, 5]);
        expectVecClose(dequantizeRallarMotionVec3(quantized, {
            min: -10,
            max: 10,
            steps: 20,
        }), [5, 0, -5]);
    });
});

function sample<TMetadata = unknown>(
    entityId: string,
    observedAtEpochMs: number,
    position: RallarMotionVec3,
    extra: Partial<Omit<RallarMotionSample<TMetadata>, 'entityId' | 'observedAtEpochMs' | 'position'>> = {},
): RallarMotionSample<TMetadata> {
    return {
        entityId,
        observedAtEpochMs,
        position,
        ...extra,
    };
}

function expectVecClose(
    actual: RallarMotionVec3 | undefined,
    expected: RallarMotionVec3,
): void {
    expect(actual).toBeDefined();
    expect(actual?.[0]).toBeCloseTo(expected[0], 6);
    expect(actual?.[1]).toBeCloseTo(expected[1], 6);
    expect(actual?.[2]).toBeCloseTo(expected[2], 6);
}
