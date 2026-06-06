import { classifyRallarMotionDiscontinuity } from './discontinuity.ts';
import {
    deadReckonRallarMotion,
    interpolateRallarMotion,
    interpolateRallarMotionHermite,
} from './interpolation.ts';
import { sanitizeRallarMotionNonNegative } from './math.ts';
import type {
    RallarMotionBuffer,
    RallarMotionBufferDiscontinuityOptions,
    RallarMotionBufferOptions,
    RallarMotionEstimate,
    RallarMotionInterpolationMode,
    RallarMotionPushResult,
    RallarMotionPushStatus,
    RallarMotionSample,
    RallarMotionSequenceGap,
} from './types.ts';

type EntityMotionTrack<TMetadata> = {
    samples: RallarMotionSample<TMetadata>[];
    latestSeq?: number;
};

type NormalizedRallarMotionBufferOptions = Readonly<{
    interpolationDelayMs: number;
    readInterpolationDelayMs?: () => number;
    maxExtrapolationMs: number;
    maxSamplesPerEntity: number;
    maxSampleAgeMs: number;
    interpolationMode: RallarMotionInterpolationMode;
    rotationWrap: RallarMotionBufferOptions['rotationWrap'];
    discontinuity?: RallarMotionBufferDiscontinuityOptions;
}>;

export const DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS: Required<
    Pick<
        RallarMotionBufferOptions,
        | 'interpolationDelayMs'
        | 'maxExtrapolationMs'
        | 'maxSamplesPerEntity'
        | 'maxSampleAgeMs'
        | 'interpolationMode'
    >
> = {
    interpolationDelayMs: 100,
    maxExtrapolationMs: 150,
    maxSamplesPerEntity: 8,
    maxSampleAgeMs: 10_000,
    interpolationMode: 'linear',
};

export function createRallarMotionBuffer<TMetadata = unknown>(
    options: RallarMotionBufferOptions = {},
): RallarMotionBuffer<TMetadata> {
    const resolved = normalizeRallarMotionBufferOptions(options);
    const tracks = new Map<string, EntityMotionTrack<TMetadata>>();

    return {
        push(sample): RallarMotionPushResult {
            const track = tracks.get(sample.entityId) ?? {
                samples: [],
                latestSeq: undefined,
            };
            const sequenceGap = sequenceGapFor(track.latestSeq, sample.seq);

            if (sample.seq !== undefined && track.latestSeq !== undefined) {
                if (sample.seq === track.latestSeq) {
                    return toPushResult(
                        'duplicate-seq',
                        sample,
                        track.samples.length,
                        0,
                    );
                }
                if (sample.seq < track.latestSeq) {
                    return toPushResult(
                        'stale-seq',
                        sample,
                        track.samples.length,
                        0,
                    );
                }
            }

            track.samples.push(sample);
            track.samples.sort(compareRallarMotionSamples);
            if (sample.seq !== undefined) {
                track.latestSeq = sample.seq;
            }

            const beforeTrim = track.samples.length;
            trimTrackToMaxSamples(track, resolved.maxSamplesPerEntity);
            const retained = track.samples.includes(sample);
            const droppedSampleCount = beforeTrim - track.samples.length;

            if (track.samples.length === 0) {
                tracks.delete(sample.entityId);
            } else {
                tracks.set(sample.entityId, track);
            }

            return toPushResult(
                retained ? 'accepted' : 'dropped-old-sample',
                sample,
                track.samples.length,
                droppedSampleCount,
                retained ? sequenceGap : undefined,
            );
        },
        sample(entityId, nowEpochMs): RallarMotionEstimate<TMetadata> | undefined {
            const track = tracks.get(entityId);
            if (!track || track.samples.length === 0) {
                return undefined;
            }

            return estimateRallarMotionTrack(
                track.samples,
                nowEpochMs - readInterpolationDelayMs(resolved),
                resolved,
            );
        },
        sampleAll(nowEpochMs): ReadonlyMap<string, RallarMotionEstimate<TMetadata>> {
            const estimates = new Map<string, RallarMotionEstimate<TMetadata>>();
            for (const entityId of tracks.keys()) {
                const estimate = this.sample(entityId, nowEpochMs);
                if (estimate) {
                    estimates.set(entityId, estimate);
                }
            }
            return estimates;
        },
        prune(nowEpochMs): number {
            const cutoff = nowEpochMs - resolved.maxSampleAgeMs;
            let removed = 0;
            for (const [entityId, track] of tracks) {
                const before = track.samples.length;
                track.samples = track.samples.filter((sample) =>
                    sample.observedAtEpochMs >= cutoff
                );
                removed += before - track.samples.length;
                if (track.samples.length === 0) {
                    tracks.delete(entityId);
                }
            }
            return removed;
        },
        remove(entityId): boolean {
            return tracks.delete(entityId);
        },
        entityIds(): readonly string[] {
            return [...tracks.keys()];
        },
    };
}

function estimateRallarMotionTrack<TMetadata>(
    samples: readonly RallarMotionSample<TMetadata>[],
    sampledAtEpochMs: number,
    options: NormalizedRallarMotionBufferOptions,
): RallarMotionEstimate<TMetadata> | undefined {
    if (samples.length === 0) {
        return undefined;
    }

    const first = samples[0];
    const latest = samples[samples.length - 1];
    if (!first || !latest) {
        return undefined;
    }

    if (sampledAtEpochMs <= first.observedAtEpochMs) {
        return holdRallarMotionSample(first, sampledAtEpochMs, 1);
    }

    for (let index = 0; index < samples.length - 1; index += 1) {
        const source = samples[index];
        const target = samples[index + 1];
        if (
            source &&
            target &&
            source.observedAtEpochMs <= sampledAtEpochMs &&
            sampledAtEpochMs <= target.observedAtEpochMs
        ) {
            if (isDiscontinuous(source, target, options.discontinuity)) {
                return sampledAtEpochMs < target.observedAtEpochMs
                    ? holdRallarMotionSample(source, sampledAtEpochMs, 1)
                    : holdRallarMotionSample(target, sampledAtEpochMs, 1);
            }

            const interpolationOptions = options.rotationWrap
                ? { rotationWrap: options.rotationWrap }
                : {};

            return options.interpolationMode === 'hermite'
                ? interpolateRallarMotionHermite(
                    source,
                    target,
                    sampledAtEpochMs,
                    interpolationOptions,
                )
                : interpolateRallarMotion(
                    source,
                    target,
                    sampledAtEpochMs,
                    interpolationOptions,
                );
        }
    }

    return deadReckonRallarMotion(
        latest,
        sampledAtEpochMs,
        options.maxExtrapolationMs,
    );
}

function holdRallarMotionSample<TMetadata>(
    sample: RallarMotionSample<TMetadata>,
    sampledAtEpochMs: number,
    confidence: number,
): RallarMotionEstimate<TMetadata> {
    return {
        entityId: sample.entityId,
        sampledAtEpochMs,
        observedAtEpochMs: sample.observedAtEpochMs,
        position: sample.position,
        rotation: sample.rotation,
        velocity: sample.velocity,
        angularVelocity: sample.angularVelocity,
        metadata: sample.metadata,
        mode: 'held',
        sourceSeq: sample.seq,
        targetSeq: sample.seq,
        sourceObservedAtEpochMs: sample.observedAtEpochMs,
        targetObservedAtEpochMs: sample.observedAtEpochMs,
        ageMs: Math.max(0, sampledAtEpochMs - sample.observedAtEpochMs),
        extrapolationMs: 0,
        confidence,
    };
}

function normalizeRallarMotionBufferOptions(
    options: RallarMotionBufferOptions,
): NormalizedRallarMotionBufferOptions {
    return {
        interpolationDelayMs: sanitizeRallarMotionNonNegative(
            options.interpolationDelayMs,
            DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.interpolationDelayMs,
        ),
        readInterpolationDelayMs: options.readInterpolationDelayMs,
        maxExtrapolationMs: sanitizeRallarMotionNonNegative(
            options.maxExtrapolationMs,
            DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.maxExtrapolationMs,
        ),
        maxSamplesPerEntity: Math.max(
            1,
            Math.floor(
                options.maxSamplesPerEntity ??
                    DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.maxSamplesPerEntity,
            ),
        ),
        maxSampleAgeMs: sanitizeRallarMotionNonNegative(
            options.maxSampleAgeMs,
            DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.maxSampleAgeMs,
        ),
        interpolationMode: options.interpolationMode ??
            DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.interpolationMode,
        rotationWrap: options.rotationWrap,
        discontinuity: normalizeDiscontinuityOptions(options.discontinuity),
    };
}

function normalizeDiscontinuityOptions(
    options: RallarMotionBufferOptions['discontinuity'],
): RallarMotionBufferDiscontinuityOptions | undefined {
    if (!options || options.enabled === false) {
        return undefined;
    }
    return options;
}

function readInterpolationDelayMs(
    options: NormalizedRallarMotionBufferOptions,
): number {
    if (!options.readInterpolationDelayMs) {
        return options.interpolationDelayMs;
    }

    return sanitizeRallarMotionNonNegative(
        options.readInterpolationDelayMs(),
        options.interpolationDelayMs,
    );
}

function isDiscontinuous<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
    options: RallarMotionBufferDiscontinuityOptions | undefined,
): boolean {
    if (!options) {
        return false;
    }

    return classifyRallarMotionDiscontinuity(source, target, options)
        .discontinuous;
}

function trimTrackToMaxSamples<TMetadata>(
    track: EntityMotionTrack<TMetadata>,
    maxSamplesPerEntity: number,
): void {
    while (track.samples.length > maxSamplesPerEntity) {
        track.samples.shift();
    }
}

function compareRallarMotionSamples<TMetadata>(
    left: RallarMotionSample<TMetadata>,
    right: RallarMotionSample<TMetadata>,
): number {
    return left.observedAtEpochMs - right.observedAtEpochMs ||
        (left.seq ?? Number.MAX_SAFE_INTEGER) -
            (right.seq ?? Number.MAX_SAFE_INTEGER);
}

function sequenceGapFor(
    previousSeq: number | undefined,
    seq: number | undefined,
): RallarMotionSequenceGap | undefined {
    if (previousSeq === undefined || seq === undefined || seq <= previousSeq + 1) {
        return undefined;
    }

    return {
        previousSeq,
        seq,
        droppedSeqCount: seq - previousSeq - 1,
    };
}

function toPushResult<TMetadata>(
    status: RallarMotionPushStatus,
    sample: RallarMotionSample<TMetadata>,
    sampleCount: number,
    droppedSampleCount: number,
    sequenceGap?: RallarMotionSequenceGap,
): RallarMotionPushResult {
    return {
        status,
        entityId: sample.entityId,
        seq: sample.seq,
        sampleCount,
        droppedSampleCount,
        sequenceGap,
    };
}
