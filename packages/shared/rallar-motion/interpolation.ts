import {
    addRallarMotionVec3,
    clampRallarMotion01,
    interpolateRallarMotionWrappedEuler,
    lerpRallarMotionVec3,
    scaleRallarMotionVec3,
    shortestRallarMotionWrappedVec3Delta,
    wrapRallarMotionAngle,
} from './math.ts';
import type {
    RallarMotionEstimate,
    RallarMotionEstimateMode,
    RallarMotionInterpolationOptions,
    RallarMotionSample,
    RallarMotionVec3,
} from './types.ts';

export function interpolateRallarMotion<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
    atEpochMs: number,
    options: RallarMotionInterpolationOptions = {},
): RallarMotionEstimate<TMetadata> {
    const t = interpolationRatio(source, target, atEpochMs);
    const metadata = newestRallarMotionSample(source, target).metadata;

    return {
        entityId: target.entityId,
        sampledAtEpochMs: atEpochMs,
        observedAtEpochMs: atEpochMs,
        position: lerpRallarMotionVec3(source.position, target.position, t),
        rotation: interpolateOptionalRallarMotionVec3(
            source.rotation,
            target.rotation,
            t,
            options,
        ),
        velocity: interpolateOptionalRallarMotionVec3(
            source.velocity,
            target.velocity,
            t,
        ),
        angularVelocity: interpolateOptionalRallarMotionVec3(
            source.angularVelocity,
            target.angularVelocity,
            t,
        ),
        metadata,
        mode: 'interpolated',
        sourceSeq: source.seq,
        targetSeq: target.seq,
        sourceObservedAtEpochMs: source.observedAtEpochMs,
        targetObservedAtEpochMs: target.observedAtEpochMs,
        ageMs: Math.max(0, atEpochMs - target.observedAtEpochMs),
        extrapolationMs: 0,
        confidence: 1,
    };
}

export function interpolateRallarMotionHermite<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
    atEpochMs: number,
    options: RallarMotionInterpolationOptions = {},
): RallarMotionEstimate<TMetadata> {
    const durationSeconds =
        (target.observedAtEpochMs - source.observedAtEpochMs) / 1_000;
    if (durationSeconds <= 0) {
        return interpolateRallarMotion(source, target, atEpochMs, options);
    }

    const t = interpolationRatio(source, target, atEpochMs);
    const metadata = newestRallarMotionSample(source, target).metadata;

    return {
        entityId: target.entityId,
        sampledAtEpochMs: atEpochMs,
        observedAtEpochMs: atEpochMs,
        position: source.velocity && target.velocity
            ? hermiteRallarMotionVec3(
                source.position,
                target.position,
                source.velocity,
                target.velocity,
                durationSeconds,
                t,
            )
            : lerpRallarMotionVec3(source.position, target.position, t),
        rotation: interpolateOptionalRallarMotionHermiteRotation(
            source,
            target,
            durationSeconds,
            t,
            options,
        ),
        velocity: interpolateOptionalRallarMotionVec3(
            source.velocity,
            target.velocity,
            t,
        ),
        angularVelocity: interpolateOptionalRallarMotionVec3(
            source.angularVelocity,
            target.angularVelocity,
            t,
        ),
        metadata,
        mode: 'interpolated',
        sourceSeq: source.seq,
        targetSeq: target.seq,
        sourceObservedAtEpochMs: source.observedAtEpochMs,
        targetObservedAtEpochMs: target.observedAtEpochMs,
        ageMs: Math.max(0, atEpochMs - target.observedAtEpochMs),
        extrapolationMs: 0,
        confidence: 1,
    };
}

export function deadReckonRallarMotion<TMetadata>(
    sample: RallarMotionSample<TMetadata>,
    atEpochMs: number,
    maxExtrapolationMs: number,
): RallarMotionEstimate<TMetadata> {
    const requestedMs = Math.max(0, atEpochMs - sample.observedAtEpochMs);
    const canExtrapolate = sample.velocity &&
        requestedMs <= Math.max(0, maxExtrapolationMs);
    const mode: RallarMotionEstimateMode = canExtrapolate
        ? 'extrapolated'
        : 'held';
    const extrapolationMs = mode === 'extrapolated' ? requestedMs : 0;
    const extrapolationSeconds = extrapolationMs / 1_000;

    return {
        entityId: sample.entityId,
        sampledAtEpochMs: atEpochMs,
        observedAtEpochMs: sample.observedAtEpochMs + extrapolationMs,
        position: canExtrapolate
            ? addRallarMotionVec3(
                sample.position,
                scaleRallarMotionVec3(sample.velocity, extrapolationSeconds),
            )
            : sample.position,
        rotation: sample.rotation && sample.angularVelocity && canExtrapolate
            ? addRallarMotionVec3(
                sample.rotation,
                scaleRallarMotionVec3(
                    sample.angularVelocity,
                    extrapolationSeconds,
                ),
            )
            : sample.rotation,
        velocity: sample.velocity,
        angularVelocity: sample.angularVelocity,
        metadata: sample.metadata,
        mode,
        sourceSeq: sample.seq,
        targetSeq: sample.seq,
        sourceObservedAtEpochMs: sample.observedAtEpochMs,
        targetObservedAtEpochMs: sample.observedAtEpochMs,
        ageMs: requestedMs,
        extrapolationMs,
        confidence: confidenceForDeadReckoning(
            requestedMs,
            maxExtrapolationMs,
            mode,
        ),
    };
}

function interpolationRatio<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
    atEpochMs: number,
): number {
    const durationMs = target.observedAtEpochMs - source.observedAtEpochMs;
    return durationMs <= 0
        ? 1
        : clampRallarMotion01((atEpochMs - source.observedAtEpochMs) / durationMs);
}

function newestRallarMotionSample<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
): RallarMotionSample<TMetadata> {
    return source.observedAtEpochMs > target.observedAtEpochMs ? source : target;
}

function interpolateOptionalRallarMotionVec3(
    source: RallarMotionVec3 | undefined,
    target: RallarMotionVec3 | undefined,
    t: number,
    options: RallarMotionInterpolationOptions = {},
): RallarMotionVec3 | undefined {
    if (!source && !target) {
        return undefined;
    }
    if (!source) {
        return target;
    }
    if (!target) {
        return source;
    }
    if (options.rotationWrap) {
        return interpolateRallarMotionWrappedEuler(
            source,
            target,
            t,
            options.rotationWrap,
        );
    }

    return lerpRallarMotionVec3(source, target, t);
}

function interpolateOptionalRallarMotionHermiteRotation<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
    durationSeconds: number,
    t: number,
    options: RallarMotionInterpolationOptions,
): RallarMotionVec3 | undefined {
    if (!source.rotation && !target.rotation) {
        return undefined;
    }
    if (!source.rotation) {
        return target.rotation;
    }
    if (!target.rotation) {
        return source.rotation;
    }
    if (!source.angularVelocity || !target.angularVelocity) {
        return interpolateOptionalRallarMotionVec3(
            source.rotation,
            target.rotation,
            t,
            options,
        );
    }

    const adjustedTarget = options.rotationWrap
        ? addRallarMotionVec3(
            source.rotation,
            shortestRallarMotionWrappedVec3Delta(
                source.rotation,
                target.rotation,
                options.rotationWrap,
            ),
        )
        : target.rotation;
    const interpolated = hermiteRallarMotionVec3(
        source.rotation,
        adjustedTarget,
        source.angularVelocity,
        target.angularVelocity,
        durationSeconds,
        t,
    );

    if (!options.rotationWrap) {
        return interpolated;
    }

    return [
        wrapRallarMotionAngle(
            interpolated[0],
            periodAt(options.rotationWrap.period, 0),
        ),
        wrapRallarMotionAngle(
            interpolated[1],
            periodAt(options.rotationWrap.period, 1),
        ),
        wrapRallarMotionAngle(
            interpolated[2],
            periodAt(options.rotationWrap.period, 2),
        ),
    ];
}

function hermiteRallarMotionVec3(
    source: RallarMotionVec3,
    target: RallarMotionVec3,
    sourceVelocity: RallarMotionVec3,
    targetVelocity: RallarMotionVec3,
    durationSeconds: number,
    t: number,
): RallarMotionVec3 {
    return [
        hermiteRallarMotionNumber(
            source[0],
            target[0],
            sourceVelocity[0] * durationSeconds,
            targetVelocity[0] * durationSeconds,
            t,
        ),
        hermiteRallarMotionNumber(
            source[1],
            target[1],
            sourceVelocity[1] * durationSeconds,
            targetVelocity[1] * durationSeconds,
            t,
        ),
        hermiteRallarMotionNumber(
            source[2],
            target[2],
            sourceVelocity[2] * durationSeconds,
            targetVelocity[2] * durationSeconds,
            t,
        ),
    ];
}

function hermiteRallarMotionNumber(
    source: number,
    target: number,
    sourceTangent: number,
    targetTangent: number,
    t: number,
): number {
    const tt = t * t;
    const ttt = tt * t;
    const h00 = 2 * ttt - 3 * tt + 1;
    const h10 = ttt - 2 * tt + t;
    const h01 = -2 * ttt + 3 * tt;
    const h11 = ttt - tt;

    return h00 * source + h10 * sourceTangent + h01 * target +
        h11 * targetTangent;
}

function confidenceForDeadReckoning(
    requestedMs: number,
    maxExtrapolationMs: number,
    mode: RallarMotionEstimateMode,
): number {
    if (requestedMs === 0) {
        return 1;
    }
    if (mode !== 'extrapolated') {
        return 0;
    }

    const windowMs = Math.max(0, maxExtrapolationMs);
    if (windowMs === 0) {
        return 0;
    }

    return clampRallarMotion01(1 - requestedMs / windowMs);
}

function periodAt(source: number | RallarMotionVec3, index: number): number {
    return typeof source === 'number' ? source : source[index];
}
