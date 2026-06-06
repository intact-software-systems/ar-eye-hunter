import {
    distanceRallarMotionVec3,
    distanceRallarMotionWrappedVec3,
    interpolateRallarMotionWrappedEuler,
    lerpRallarMotionVec3,
} from './math.ts';
import type {
    RallarMotionCorrectionBlender,
    RallarMotionCorrectionBlenderOptions,
    RallarMotionCorrectionInput,
    RallarMotionCorrectionPose,
    RallarMotionCorrectionResult,
} from './types.ts';

const DEFAULT_CORRECTION_BLEND_DURATION_MS = 100;

type ActiveCorrection = Readonly<{
    source: RallarMotionCorrectionPose;
    target: RallarMotionCorrectionPose;
    startedAtEpochMs: number;
    completedAtEpochMs: number;
}>;

export function createRallarMotionCorrectionBlender(
    options: RallarMotionCorrectionBlenderOptions = {},
): RallarMotionCorrectionBlender {
    const blendDurationMs = Math.max(
        0,
        options.blendDurationMs ?? DEFAULT_CORRECTION_BLEND_DURATION_MS,
    );
    let active: ActiveCorrection | undefined;

    return {
        correct(input: RallarMotionCorrectionInput): RallarMotionCorrectionResult {
            if (shouldSnap(input.current, input.target, options) || blendDurationMs === 0) {
                active = undefined;
                return {
                    position: input.target.position,
                    rotation: input.target.rotation,
                    mode: 'snapped',
                    progress: 1,
                    startedAtEpochMs: input.nowEpochMs,
                    completedAtEpochMs: input.nowEpochMs,
                };
            }

            active = {
                source: input.current,
                target: input.target,
                startedAtEpochMs: input.nowEpochMs,
                completedAtEpochMs: input.nowEpochMs + blendDurationMs,
            };

            return sampleCorrection(active, input.nowEpochMs, options);
        },
        sample(nowEpochMs): RallarMotionCorrectionResult | undefined {
            if (!active) {
                return undefined;
            }

            const result = sampleCorrection(active, nowEpochMs, options);
            if (result.mode === 'settled') {
                active = undefined;
            }
            return result;
        },
        reset(): void {
            active = undefined;
        },
    };
}

function shouldSnap(
    current: RallarMotionCorrectionPose,
    target: RallarMotionCorrectionPose,
    options: RallarMotionCorrectionBlenderOptions,
): boolean {
    if (
        options.snapPositionDelta !== undefined &&
        distanceRallarMotionVec3(current.position, target.position) >
            options.snapPositionDelta
    ) {
        return true;
    }

    if (
        current.rotation &&
        target.rotation &&
        options.snapRotationDelta !== undefined &&
        distanceRallarMotionWrappedVec3(
                current.rotation,
                target.rotation,
                options.rotationWrap,
            ) > options.snapRotationDelta
    ) {
        return true;
    }

    return false;
}

function sampleCorrection(
    active: ActiveCorrection,
    nowEpochMs: number,
    options: RallarMotionCorrectionBlenderOptions,
): RallarMotionCorrectionResult {
    const durationMs = active.completedAtEpochMs - active.startedAtEpochMs;
    const progress = durationMs <= 0
        ? 1
        : Math.max(
            0,
            Math.min(1, (nowEpochMs - active.startedAtEpochMs) / durationMs),
        );

    return {
        position: lerpRallarMotionVec3(
            active.source.position,
            active.target.position,
            progress,
        ),
        rotation: interpolateCorrectionRotation(active, progress, options),
        mode: progress >= 1 ? 'settled' : 'blending',
        progress,
        startedAtEpochMs: active.startedAtEpochMs,
        completedAtEpochMs: active.completedAtEpochMs,
    };
}

function interpolateCorrectionRotation(
    active: ActiveCorrection,
    progress: number,
    options: RallarMotionCorrectionBlenderOptions,
) {
    if (!active.source.rotation && !active.target.rotation) {
        return undefined;
    }
    if (!active.source.rotation) {
        return active.target.rotation;
    }
    if (!active.target.rotation) {
        return active.source.rotation;
    }
    if (options.rotationWrap) {
        return interpolateRallarMotionWrappedEuler(
            active.source.rotation,
            active.target.rotation,
            progress,
            options.rotationWrap,
        );
    }

    return lerpRallarMotionVec3(
        active.source.rotation,
        active.target.rotation,
        progress,
    );
}
