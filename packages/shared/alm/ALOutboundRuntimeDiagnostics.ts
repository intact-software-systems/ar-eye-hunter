import type {
    ALOutboundEffectSettlement,
    ALPersistedOutboundEffect,
} from './ALOutboundAdmissionStore.ts';

export type ALOutboundEffectKind =
    ALPersistedOutboundEffect<unknown>['payload']['kind'];

export type ALOutboundEffectKindCounts = Readonly<
    Record<ALOutboundEffectKind, number>
>;

export type ALOutboundEffectReadyLatenessHistogram = Readonly<{
    le0Ms: number;
    le10Ms: number;
    le50Ms: number;
    le100Ms: number;
    le250Ms: number;
    le500Ms: number;
    le1000Ms: number;
    le2500Ms: number;
    le5000Ms: number;
    gt5000Ms: number;
}>;

export type ALOutboundEffectDrainComposition = Readonly<{
    claimedByKind: ALOutboundEffectKindCounts;
    completedByKind: ALOutboundEffectKindCounts;
    rescheduledByKind: ALOutboundEffectKindCounts;
    claimedFirstAttemptCount: number;
    claimedRetryAttemptCount: number;
    firstAttemptReadyLateness: ALOutboundEffectReadyLatenessHistogram;
    retryAttemptReadyLateness: ALOutboundEffectReadyLatenessHistogram;
}>;

type MutableEffectKindCounts = Record<ALOutboundEffectKind, number>;
type MutableReadyLatenessHistogram = Record<
    keyof ALOutboundEffectReadyLatenessHistogram,
    number
>;

export type ALOutboundEffectDrainAccumulator = {
    claimedByKind: MutableEffectKindCounts;
    completedByKind: MutableEffectKindCounts;
    rescheduledByKind: MutableEffectKindCounts;
    claimedFirstAttemptCount: number;
    claimedRetryAttemptCount: number;
    firstAttemptReadyLateness: MutableReadyLatenessHistogram;
    retryAttemptReadyLateness: MutableReadyLatenessHistogram;
};

function toEmptyEffectKindCounts(): MutableEffectKindCounts {
    return {
        'send-prepared': 0,
        'enqueue-outbox': 0,
        'fallback-dispatch': 0,
        'ack-timeout': 0,
        'repair-hint': 0,
        'nack-retry': 0,
    };
}

function toEmptyReadyLatenessHistogram(): MutableReadyLatenessHistogram {
    return {
        le0Ms: 0,
        le10Ms: 0,
        le50Ms: 0,
        le100Ms: 0,
        le250Ms: 0,
        le500Ms: 0,
        le1000Ms: 0,
        le2500Ms: 0,
        le5000Ms: 0,
        gt5000Ms: 0,
    };
}

export function createOutboundEffectDrainAccumulator():
    ALOutboundEffectDrainAccumulator {
    return {
        claimedByKind: toEmptyEffectKindCounts(),
        completedByKind: toEmptyEffectKindCounts(),
        rescheduledByKind: toEmptyEffectKindCounts(),
        claimedFirstAttemptCount: 0,
        claimedRetryAttemptCount: 0,
        firstAttemptReadyLateness: toEmptyReadyLatenessHistogram(),
        retryAttemptReadyLateness: toEmptyReadyLatenessHistogram(),
    };
}

function recordReadyLateness(
    histogram: MutableReadyLatenessHistogram,
    latenessMs: number,
): void {
    const value = Math.max(0, latenessMs);
    const key: keyof MutableReadyLatenessHistogram = value <= 0
        ? 'le0Ms'
        : value <= 10
        ? 'le10Ms'
        : value <= 50
        ? 'le50Ms'
        : value <= 100
        ? 'le100Ms'
        : value <= 250
        ? 'le250Ms'
        : value <= 500
        ? 'le500Ms'
        : value <= 1_000
        ? 'le1000Ms'
        : value <= 2_500
        ? 'le2500Ms'
        : value <= 5_000
        ? 'le5000Ms'
        : 'gt5000Ms';
    histogram[key] += 1;
}

export function recordOutboundEffectClaim(
    accumulator: ALOutboundEffectDrainAccumulator,
    effect: ALPersistedOutboundEffect<unknown>,
    claimStartedAtMs: number,
): void {
    accumulator.claimedByKind[effect.payload.kind] += 1;
    const isFirstAttempt = effect.attempts === 1;
    if (isFirstAttempt) {
        accumulator.claimedFirstAttemptCount += 1;
    } else {
        accumulator.claimedRetryAttemptCount += 1;
    }
    recordReadyLateness(
        isFirstAttempt
            ? accumulator.firstAttemptReadyLateness
            : accumulator.retryAttemptReadyLateness,
        claimStartedAtMs - effect.retryAtMs,
    );
}

export function recordOutboundEffectOutcome(
    accumulator: ALOutboundEffectDrainAccumulator,
    effect: ALPersistedOutboundEffect<unknown>,
    status: ALOutboundEffectSettlement['status'],
): void {
    const counts = status === 'completed'
        ? accumulator.completedByKind
        : accumulator.rescheduledByKind;
    counts[effect.payload.kind] += 1;
}

export function snapshotOutboundEffectDrainComposition(
    accumulator: ALOutboundEffectDrainAccumulator,
): ALOutboundEffectDrainComposition {
    return {
        claimedByKind: { ...accumulator.claimedByKind },
        completedByKind: { ...accumulator.completedByKind },
        rescheduledByKind: { ...accumulator.rescheduledByKind },
        claimedFirstAttemptCount: accumulator.claimedFirstAttemptCount,
        claimedRetryAttemptCount: accumulator.claimedRetryAttemptCount,
        firstAttemptReadyLateness: { ...accumulator.firstAttemptReadyLateness },
        retryAttemptReadyLateness: { ...accumulator.retryAttemptReadyLateness },
    };
}
