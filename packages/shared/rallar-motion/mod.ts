export type RallarMotionVec3 = readonly [number, number, number];

export type RallarMotionSample<TMetadata = unknown> = Readonly<{
    entityId: string;
    observedAtEpochMs: number;
    position: RallarMotionVec3;
    rotation?: RallarMotionVec3;
    velocity?: RallarMotionVec3;
    angularVelocity?: RallarMotionVec3;
    seq?: number;
    metadata?: TMetadata;
}>;

export type RallarMotionEstimateMode =
    | 'interpolated'
    | 'extrapolated'
    | 'held';

export type RallarMotionEstimate<TMetadata = unknown> = Readonly<{
    entityId: string;
    sampledAtEpochMs: number;
    observedAtEpochMs: number;
    position: RallarMotionVec3;
    rotation?: RallarMotionVec3;
    velocity?: RallarMotionVec3;
    angularVelocity?: RallarMotionVec3;
    metadata?: TMetadata;
    mode: RallarMotionEstimateMode;
    sourceSeq?: number;
    targetSeq?: number;
    sourceObservedAtEpochMs: number;
    targetObservedAtEpochMs?: number;
    ageMs: number;
    extrapolationMs: number;
}>;

export type RallarMotionBufferOptions = Readonly<{
    interpolationDelayMs?: number;
    maxExtrapolationMs?: number;
    maxSamplesPerEntity?: number;
    maxSampleAgeMs?: number;
}>;

export type RallarMotionPushStatus =
    | 'accepted'
    | 'duplicate-seq'
    | 'stale-seq'
    | 'dropped-old-sample';

export type RallarMotionPushResult = Readonly<{
    status: RallarMotionPushStatus;
    entityId: string;
    seq?: number;
    sampleCount: number;
    droppedSampleCount: number;
}>;

export type RallarMotionBuffer<TMetadata = unknown> = Readonly<{
    push(sample: RallarMotionSample<TMetadata>): RallarMotionPushResult;
    sample(
        entityId: string,
        nowEpochMs: number,
    ): RallarMotionEstimate<TMetadata> | undefined;
    sampleAll(nowEpochMs: number): ReadonlyMap<string, RallarMotionEstimate<TMetadata>>;
    prune(nowEpochMs: number): number;
    remove(entityId: string): boolean;
    entityIds(): readonly string[];
}>;

type EntityMotionTrack<TMetadata> = {
    samples: RallarMotionSample<TMetadata>[];
    latestSeq?: number;
};

type NormalizedRallarMotionBufferOptions = Required<RallarMotionBufferOptions>;

export const DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS: NormalizedRallarMotionBufferOptions = {
    interpolationDelayMs: 100,
    maxExtrapolationMs: 150,
    maxSamplesPerEntity: 8,
    maxSampleAgeMs: 10_000,
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

            if (sample.seq !== undefined && track.latestSeq !== undefined) {
                if (sample.seq === track.latestSeq) {
                    return toPushResult('duplicate-seq', sample, track.samples.length, 0);
                }
                if (sample.seq < track.latestSeq) {
                    return toPushResult('stale-seq', sample, track.samples.length, 0);
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
            );
        },
        sample(entityId, nowEpochMs): RallarMotionEstimate<TMetadata> | undefined {
            const track = tracks.get(entityId);
            if (!track || track.samples.length === 0) {
                return undefined;
            }

            return estimateRallarMotionTrack(
                track.samples,
                nowEpochMs - resolved.interpolationDelayMs,
                resolved.maxExtrapolationMs,
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

export function interpolateRallarMotion<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
    atEpochMs: number,
): RallarMotionEstimate<TMetadata> {
    const durationMs = target.observedAtEpochMs - source.observedAtEpochMs;
    const t = durationMs <= 0
        ? 1
        : clamp01((atEpochMs - source.observedAtEpochMs) / durationMs);
    const metadata = newestSample(source, target).metadata;

    return {
        entityId: target.entityId,
        sampledAtEpochMs: atEpochMs,
        observedAtEpochMs: atEpochMs,
        position: lerpVec3(source.position, target.position, t),
        rotation: interpolateOptionalVec3(source.rotation, target.rotation, t),
        velocity: interpolateOptionalVec3(source.velocity, target.velocity, t),
        angularVelocity: interpolateOptionalVec3(
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
    };
}

export function deadReckonRallarMotion<TMetadata>(
    sample: RallarMotionSample<TMetadata>,
    atEpochMs: number,
    maxExtrapolationMs: number,
): RallarMotionEstimate<TMetadata> {
    const requestedMs = Math.max(0, atEpochMs - sample.observedAtEpochMs);
    const mode: RallarMotionEstimateMode = sample.velocity && requestedMs <= maxExtrapolationMs
        ? 'extrapolated'
        : 'held';
    const extrapolationMs = mode === 'extrapolated' ? requestedMs : 0;
    const extrapolationSeconds = extrapolationMs / 1_000;

    return {
        entityId: sample.entityId,
        sampledAtEpochMs: atEpochMs,
        observedAtEpochMs: sample.observedAtEpochMs + extrapolationMs,
        position: sample.velocity
            ? addVec3(sample.position, scaleVec3(sample.velocity, extrapolationSeconds))
            : sample.position,
        rotation: sample.rotation && sample.angularVelocity
            ? addVec3(sample.rotation, scaleVec3(sample.angularVelocity, extrapolationSeconds))
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
    };
}

export function estimateRallarMotionVelocity(
    previous: Pick<RallarMotionSample, 'observedAtEpochMs' | 'position'>,
    next: Pick<RallarMotionSample, 'observedAtEpochMs' | 'position'>,
): RallarMotionVec3 | undefined {
    const deltaSeconds = (next.observedAtEpochMs - previous.observedAtEpochMs) / 1_000;
    if (deltaSeconds <= 0) {
        return undefined;
    }

    return [
        (next.position[0] - previous.position[0]) / deltaSeconds,
        (next.position[1] - previous.position[1]) / deltaSeconds,
        (next.position[2] - previous.position[2]) / deltaSeconds,
    ];
}

export function shouldSendRallarMotionSample(
    nowEpochMs: number,
    nextAllowedEpochMs: number,
    cadenceMs: number,
): boolean {
    return cadenceMs <= 0 || nowEpochMs >= nextAllowedEpochMs;
}

function estimateRallarMotionTrack<TMetadata>(
    samples: readonly RallarMotionSample<TMetadata>[],
    sampledAtEpochMs: number,
    maxExtrapolationMs: number,
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
        return holdRallarMotionSample(first, sampledAtEpochMs);
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
            return interpolateRallarMotion(source, target, sampledAtEpochMs);
        }
    }

    return deadReckonRallarMotion(latest, sampledAtEpochMs, maxExtrapolationMs);
}

function holdRallarMotionSample<TMetadata>(
    sample: RallarMotionSample<TMetadata>,
    sampledAtEpochMs: number,
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
    };
}

function normalizeRallarMotionBufferOptions(
    options: RallarMotionBufferOptions,
): NormalizedRallarMotionBufferOptions {
    return {
        interpolationDelayMs: Math.max(
            0,
            options.interpolationDelayMs ??
                DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.interpolationDelayMs,
        ),
        maxExtrapolationMs: Math.max(
            0,
            options.maxExtrapolationMs ??
                DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.maxExtrapolationMs,
        ),
        maxSamplesPerEntity: Math.max(
            1,
            Math.floor(
                options.maxSamplesPerEntity ??
                    DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.maxSamplesPerEntity,
            ),
        ),
        maxSampleAgeMs: Math.max(
            0,
            options.maxSampleAgeMs ??
                DEFAULT_RALLAR_MOTION_BUFFER_OPTIONS.maxSampleAgeMs,
        ),
    };
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

function toPushResult<TMetadata>(
    status: RallarMotionPushStatus,
    sample: RallarMotionSample<TMetadata>,
    sampleCount: number,
    droppedSampleCount: number,
): RallarMotionPushResult {
    return {
        status,
        entityId: sample.entityId,
        seq: sample.seq,
        sampleCount,
        droppedSampleCount,
    };
}

function newestSample<TMetadata>(
    source: RallarMotionSample<TMetadata>,
    target: RallarMotionSample<TMetadata>,
): RallarMotionSample<TMetadata> {
    return source.observedAtEpochMs > target.observedAtEpochMs ? source : target;
}

function interpolateOptionalVec3(
    source: RallarMotionVec3 | undefined,
    target: RallarMotionVec3 | undefined,
    t: number,
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

    return lerpVec3(source, target, t);
}

function lerpVec3(
    source: RallarMotionVec3,
    target: RallarMotionVec3,
    t: number,
): RallarMotionVec3 {
    return [
        lerp(source[0], target[0], t),
        lerp(source[1], target[1], t),
        lerp(source[2], target[2], t),
    ];
}

function addVec3(
    source: RallarMotionVec3,
    delta: RallarMotionVec3,
): RallarMotionVec3 {
    return [
        source[0] + delta[0],
        source[1] + delta[1],
        source[2] + delta[2],
    ];
}

function scaleVec3(
    source: RallarMotionVec3,
    scalar: number,
): RallarMotionVec3 {
    return [
        source[0] * scalar,
        source[1] * scalar,
        source[2] * scalar,
    ];
}

function lerp(source: number, target: number, t: number): number {
    return source + (target - source) * t;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}
