import { describe, expect, it } from 'vitest';
import {
    createRallarMotionBuffer,
    deadReckonRallarMotion,
    estimateRallarMotionVelocity,
    interpolateRallarMotion,
    shouldSendRallarMotionSample,
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
