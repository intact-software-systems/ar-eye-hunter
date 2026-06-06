import {
    shortestRallarMotionWrappedVec3Delta,
    smoothRallarMotionVec3,
} from './math.ts';
import type {
    RallarMotionKinematicsEstimate,
    RallarMotionKinematicsEstimator,
    RallarMotionKinematicsEstimatorOptions,
    RallarMotionSample,
    RallarMotionVec3,
} from './types.ts';

type KinematicsTrack = {
    sample?: Pick<
        RallarMotionSample,
        'entityId' | 'observedAtEpochMs' | 'position' | 'rotation'
    >;
    velocity?: RallarMotionVec3;
};

export function estimateRallarMotionVelocity(
    previous: Pick<RallarMotionSample, 'observedAtEpochMs' | 'position'>,
    next: Pick<RallarMotionSample, 'observedAtEpochMs' | 'position'>,
): RallarMotionVec3 | undefined {
    const deltaSeconds = (next.observedAtEpochMs - previous.observedAtEpochMs) /
        1_000;
    if (deltaSeconds <= 0) {
        return undefined;
    }

    return [
        (next.position[0] - previous.position[0]) / deltaSeconds,
        (next.position[1] - previous.position[1]) / deltaSeconds,
        (next.position[2] - previous.position[2]) / deltaSeconds,
    ];
}

export function estimateRallarMotionAcceleration(
    previous: Pick<RallarMotionSample, 'observedAtEpochMs' | 'velocity'>,
    next: Pick<RallarMotionSample, 'observedAtEpochMs' | 'velocity'>,
): RallarMotionVec3 | undefined {
    const deltaSeconds = (next.observedAtEpochMs - previous.observedAtEpochMs) /
        1_000;
    if (deltaSeconds <= 0 || !previous.velocity || !next.velocity) {
        return undefined;
    }

    return [
        (next.velocity[0] - previous.velocity[0]) / deltaSeconds,
        (next.velocity[1] - previous.velocity[1]) / deltaSeconds,
        (next.velocity[2] - previous.velocity[2]) / deltaSeconds,
    ];
}

export function createRallarMotionKinematicsEstimator(
    options: RallarMotionKinematicsEstimatorOptions = {},
): RallarMotionKinematicsEstimator {
    const tracks = new Map<string, KinematicsTrack>();
    const alpha = options.smoothingAlpha === undefined
        ? undefined
        : Math.max(0, Math.min(1, options.smoothingAlpha));

    return {
        push(sample): RallarMotionKinematicsEstimate {
            const track = tracks.get(sample.entityId) ?? {};
            const previousSample = track.sample;
            const rawVelocity = previousSample
                ? estimateRallarMotionVelocity(previousSample, sample)
                : undefined;
            const velocity = rawVelocity && track.velocity && alpha !== undefined
                ? smoothRallarMotionVec3(track.velocity, rawVelocity, alpha)
                : rawVelocity;
            const acceleration = previousSample && velocity && track.velocity
                ? estimateRallarMotionAcceleration(
                    {
                        observedAtEpochMs: previousSample.observedAtEpochMs,
                        velocity: track.velocity,
                    },
                    {
                        observedAtEpochMs: sample.observedAtEpochMs,
                        velocity,
                    },
                )
                : undefined;
            const angularVelocity = previousSample?.rotation && sample.rotation
                ? estimateAngularVelocity(previousSample, sample, options)
                : undefined;

            tracks.set(sample.entityId, {
                sample,
                velocity: velocity ?? track.velocity,
            });

            return {
                entityId: sample.entityId,
                observedAtEpochMs: sample.observedAtEpochMs,
                velocity,
                angularVelocity,
                acceleration,
            };
        },
        remove(entityId): boolean {
            return tracks.delete(entityId);
        },
        reset(): void {
            tracks.clear();
        },
    };
}

function estimateAngularVelocity(
    previous: Pick<
        RallarMotionSample,
        'observedAtEpochMs' | 'position' | 'rotation'
    >,
    next: Pick<RallarMotionSample, 'observedAtEpochMs' | 'position' | 'rotation'>,
    options: RallarMotionKinematicsEstimatorOptions,
): RallarMotionVec3 | undefined {
    if (!previous.rotation || !next.rotation) {
        return undefined;
    }

    const deltaSeconds = (next.observedAtEpochMs - previous.observedAtEpochMs) /
        1_000;
    if (deltaSeconds <= 0) {
        return undefined;
    }

    const delta = options.rotationWrap
        ? shortestRallarMotionWrappedVec3Delta(
            previous.rotation,
            next.rotation,
            options.rotationWrap,
        )
        : [
            next.rotation[0] - previous.rotation[0],
            next.rotation[1] - previous.rotation[1],
            next.rotation[2] - previous.rotation[2],
        ] as RallarMotionVec3;

    return [
        delta[0] / deltaSeconds,
        delta[1] / deltaSeconds,
        delta[2] / deltaSeconds,
    ];
}
