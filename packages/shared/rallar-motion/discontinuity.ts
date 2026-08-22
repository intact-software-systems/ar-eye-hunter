import { distanceRallarMotionVec3, distanceRallarMotionWrappedVec3 } from './math.ts';
import type { RallarMotionDiscontinuityOptions, RallarMotionDiscontinuityResult, RallarMotionSample } from './types.ts';

export function classifyRallarMotionDiscontinuity<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
    options: RallarMotionDiscontinuityOptions = {}
): RallarMotionDiscontinuityResult {
    const positionDistance = distanceRallarMotionVec3(
        source.position,
        target.position
    );

    if (
        options.maxPositionDelta !== undefined &&
        positionDistance > options.maxPositionDelta
    ) {
        return {
            discontinuous: true,
            reason: 'position-distance',
            positionDistance,
            threshold: options.maxPositionDelta
        };
    }

    const deltaSeconds = (target.observedAtEpochMs - source.observedAtEpochMs) / 1_000;
    if (
        options.maxSpeed !== undefined &&
        deltaSeconds > 0 &&
        positionDistance / deltaSeconds > options.maxSpeed
    ) {
        return {
            discontinuous: true,
            reason: 'speed',
            positionDistance,
            speed: positionDistance / deltaSeconds,
            threshold: options.maxSpeed
        };
    }

    if (
        source.rotation &&
        target.rotation &&
        options.maxRotationDelta !== undefined
    ) {
        const rotationDistance = distanceRallarMotionWrappedVec3(
            source.rotation,
            target.rotation,
            options.rotationWrap
        );
        if (rotationDistance > options.maxRotationDelta) {
            return {
                discontinuous: true,
                reason: 'rotation-distance',
                positionDistance,
                rotationDistance,
                threshold: options.maxRotationDelta
            };
        }
    }

    return {
        discontinuous: false,
        positionDistance
    };
}
