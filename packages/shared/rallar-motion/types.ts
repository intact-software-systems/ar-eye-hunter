export type RallarMotionVec3 = readonly [number, number, number];

export type RallarMotionQuantizedVec3 = readonly [number, number, number];

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
    confidence: number;
}>;

export type RallarMotionInterpolationMode =
    | 'linear'
    | 'hermite';

export type RallarMotionRotationWrap = Readonly<{
    period: number | RallarMotionVec3;
}>;

export type RallarMotionInterpolationOptions = Readonly<{
    rotationWrap?: RallarMotionRotationWrap;
}>;

export type RallarMotionDiscontinuityReason =
    | 'position-distance'
    | 'rotation-distance'
    | 'speed';

export type RallarMotionDiscontinuityOptions = Readonly<{
    maxPositionDelta?: number;
    maxRotationDelta?: number;
    maxSpeed?: number;
    rotationWrap?: RallarMotionRotationWrap;
}>;

export type RallarMotionDiscontinuityResult = Readonly<{
    discontinuous: boolean;
    reason?: RallarMotionDiscontinuityReason;
    positionDistance?: number;
    rotationDistance?: number;
    speed?: number;
    threshold?: number;
}>;

export type RallarMotionBufferDiscontinuityOptions =
    & RallarMotionDiscontinuityOptions
    & Readonly<{
        enabled?: boolean;
    }>;

export type RallarMotionBufferOptions = Readonly<{
    interpolationDelayMs?: number;
    readInterpolationDelayMs?: () => number;
    maxExtrapolationMs?: number;
    maxSamplesPerEntity?: number;
    maxSampleAgeMs?: number;
    interpolationMode?: RallarMotionInterpolationMode;
    rotationWrap?: RallarMotionRotationWrap;
    discontinuity?: RallarMotionBufferDiscontinuityOptions | false;
}>;

export type RallarMotionSequenceGap = Readonly<{
    previousSeq: number;
    seq: number;
    droppedSeqCount: number;
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
    sequenceGap?: RallarMotionSequenceGap;
}>;

export type RallarMotionBuffer<TMetadata = unknown> = Readonly<{
    push(sample: RallarMotionSample<TMetadata>): RallarMotionPushResult;
    sample(
        entityId: string,
        nowEpochMs: number
    ): RallarMotionEstimate<TMetadata> | undefined;
    sampleAll(nowEpochMs: number): ReadonlyMap<string, RallarMotionEstimate<TMetadata>>;
    prune(nowEpochMs: number): number;
    remove(entityId: string): boolean;
    entityIds(): readonly string[];
}>;

export type RallarMotionAdaptiveDelayOptions = Readonly<{
    defaultDelayMs?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    smoothingAlpha?: number;
    jitterMultiplier?: number;
    safetyMarginMs?: number;
}>;

export type RallarMotionAdaptiveDelay = Readonly<{
    pushObservedAt(observedAtEpochMs: number): number;
    pushInterval(intervalMs: number): number;
    currentDelayMs(): number;
    reset(): void;
}>;

export type RallarMotionCorrectionPose = Readonly<{
    position: RallarMotionVec3;
    rotation?: RallarMotionVec3;
}>;

export type RallarMotionCorrectionMode =
    | 'blending'
    | 'settled'
    | 'snapped';

export type RallarMotionCorrectionBlenderOptions = Readonly<{
    blendDurationMs?: number;
    snapPositionDelta?: number;
    snapRotationDelta?: number;
    rotationWrap?: RallarMotionRotationWrap;
}>;

export type RallarMotionCorrectionInput = Readonly<{
    current: RallarMotionCorrectionPose;
    target: RallarMotionCorrectionPose;
    nowEpochMs: number;
}>;

export type RallarMotionCorrectionResult = Readonly<{
    position: RallarMotionVec3;
    rotation?: RallarMotionVec3;
    mode: RallarMotionCorrectionMode;
    progress: number;
    startedAtEpochMs: number;
    completedAtEpochMs: number;
}>;

export type RallarMotionCorrectionBlender = Readonly<{
    correct(input: RallarMotionCorrectionInput): RallarMotionCorrectionResult;
    sample(nowEpochMs: number): RallarMotionCorrectionResult | undefined;
    reset(): void;
}>;

export type RallarMotionSendSampleLike = Readonly<{
    position: RallarMotionVec3;
    rotation?: RallarMotionVec3;
    velocity?: RallarMotionVec3;
}>;

export type RallarMotionSendGateOptions = Readonly<{
    cadenceMs?: number;
    idleCadenceMs?: number;
    forceSendAfterMs?: number;
    minPositionDelta?: number;
    minRotationDelta?: number;
    minVelocityDelta?: number;
    rotationWrap?: RallarMotionRotationWrap;
}>;

export type RallarMotionSendUpdateReason =
    | 'initial'
    | 'position'
    | 'rotation'
    | 'velocity'
    | 'force'
    | 'idle'
    | 'waiting';

export type RallarMotionSendUpdateInput =
    & RallarMotionSendGateOptions
    & Readonly<{
        nowEpochMs: number;
        lastSentAtEpochMs?: number;
        lastSentSample?: RallarMotionSendSampleLike;
        nextSample: RallarMotionSendSampleLike;
    }>;

export type RallarMotionSendUpdateDecision = Readonly<{
    shouldSend: boolean;
    reason: RallarMotionSendUpdateReason;
    nextAllowedEpochMs: number;
}>;

export type RallarMotionSendGate = Readonly<{
    check(
        sample: RallarMotionSendSampleLike,
        nowEpochMs: number
    ): RallarMotionSendUpdateDecision;
    recordSent(sample: RallarMotionSendSampleLike, nowEpochMs: number): void;
    reset(): void;
}>;

export type RallarMotionKinematicsEstimatorOptions = Readonly<{
    smoothingAlpha?: number;
    rotationWrap?: RallarMotionRotationWrap;
}>;

export type RallarMotionKinematicsEstimate = Readonly<{
    entityId: string;
    observedAtEpochMs: number;
    velocity?: RallarMotionVec3;
    angularVelocity?: RallarMotionVec3;
    acceleration?: RallarMotionVec3;
}>;

export type RallarMotionKinematicsEstimator = Readonly<{
    push(
        sample: Pick<RallarMotionSample, 'entityId' | 'observedAtEpochMs' | 'position' | 'rotation'>
    ): RallarMotionKinematicsEstimate;
    remove(entityId: string): boolean;
    reset(): void;
}>;

export type RallarMotionDiagnosticsSummary = Readonly<{
    acceptedCount: number;
    duplicateSeqCount: number;
    staleSeqCount: number;
    droppedOldSampleCount: number;
    sequenceGapCount: number;
    droppedSequenceCount: number;
    intervalCount: number;
    averageIntervalMs?: number;
    averageJitterMs?: number;
    maxIntervalMs?: number;
}>;

export type RallarMotionDiagnosticsTrackerOptions = Readonly<Record<string, never>>;

export type RallarMotionDiagnosticsTracker = Readonly<{
    recordPush(
        result: RallarMotionPushResult,
        sample?: Pick<RallarMotionSample, 'entityId' | 'observedAtEpochMs'>
    ): RallarMotionDiagnosticsSummary;
    recordSample(
        sample: Pick<RallarMotionSample, 'entityId' | 'observedAtEpochMs'>
    ): RallarMotionDiagnosticsSummary;
    summary(): RallarMotionDiagnosticsSummary;
    reset(): void;
}>;

export type RallarMotionQuantizeVec3Options = Readonly<{
    min: number | RallarMotionVec3;
    max: number | RallarMotionVec3;
    steps?: number;
    bits?: number;
}>;
