import type { ALOrderingObservation } from '../../../al-contracts/al-runtime.ts';
import { jsonEquals } from '../../../repository/state-utils.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALInboundAdmissionMutation, ALInboundDeliveryProgress } from '../al-inbound-admission-store.ts';
import type { ALInboundResolvedDeliverySnapshot } from '../al-inbound-ordering-validation.ts';
import type { ALInboundIndexedMarker } from './al-inbound-delivered-marker-index.ts';

/** One ordered delivery's completion: what it read, and the position it completes through. */
export interface ALInboundDeliveryCompletion {
    readonly trackKey: string;
    readonly seq: number;
    /** The slot as the completion read it; the write requires the stored slot to equal it. */
    readonly observedSlot: ALInboundResolvedDeliverySnapshot;
    /** The progress as the completion read it; the write requires the stored `completedThrough` to equal its. */
    readonly observedProgress: ALInboundDeliveryProgress;
    readonly completesThrough: number;
}

/**
 * The completion's write against what the store holds now: the progress moved to `completesThrough` and the delivered
 * slot deleted, keeping the later of the stored and observed expiry. `conflict` when the stored `completedThrough` or
 * the stored slot is not the one the completion read.
 */
export function computeALInboundDeliveryCompletionMutations(
    completion: ALInboundDeliveryCompletion,
    storedSlot: ALInboundResolvedDeliverySnapshot | undefined,
    storedProgress: ALInboundDeliveryProgress | undefined
): Either<'conflict', readonly ALInboundAdmissionMutation[]> {
    const { trackKey, seq, observedProgress } = completion;
    if (
        storedProgress === undefined || storedProgress.completedThrough !== observedProgress.completedThrough ||
        !jsonEquals(storedSlot, completion.observedSlot)
    ) {
        return Either.ofLeft('conflict');
    }
    return Either.ofRight([{
        kind: 'set-delivery-progress',
        trackKey,
        value: {
            completedThrough: completion.completesThrough,
            expireAtTimestamp: Math.max(storedProgress.expireAtTimestamp, observedProgress.expireAtTimestamp)
        }
    }, { kind: 'delete-buffered', trackKey, seq }]);
}

export interface ALInboundDeliveryCompletionInput {
    readonly completedThrough: number;
    readonly seq: number;
    /** The observation the copy's admission recorded on its slot. */
    readonly observation: ALOrderingObservation;
    /** What the copy's slot says its completion reaches: `seq`, or past the copies a bounded hold passed after it. */
    readonly completesThrough: number;
}

/**
 * The progress a delivery moves its track to once its predecessor completed, past any omission: through its own
 * sequence, or through the expired copies a bounded hold passed after the run this copy ends, which no delivery will
 * complete. `undefined` while it cannot complete.
 */
export function computeALInboundDeliveryCompletion(input: ALInboundDeliveryCompletionInput): number | undefined {
    const predecessorSeq = computeALOrderingDeliveryPredecessorSeq(input.observation) ?? input.seq - 1;
    return input.seq > input.completedThrough && predecessorSeq <= input.completedThrough
        ? input.completesThrough
        : undefined;
}

/** Whether a slot's completed delivery completes `seq`: its own sequence, or one its reach passes. */
export function isALInboundDeliveryReaching(
    slot: Readonly<{ seq: number; completesThrough: number; }>,
    seq: number
): boolean {
    return slot.seq <= seq && seq <= slot.completesThrough;
}

export interface ALInboundWitnessedProgressInput {
    readonly completedThrough: number;
    /** The track position before the witness, `0` when the receiver held none. */
    readonly previousPosition: number;
    readonly witnessedPosition: number;
}

/**
 * A witnessed copy is never delivered, so the progress passes it once every delivery up to the previous position
 * completed; a delivery still owed below keeps the progress where it is.
 */
export function computeALInboundWitnessedCompletedThrough(input: ALInboundWitnessedProgressInput): number {
    return input.completedThrough >= input.previousPosition
        ? Math.max(input.completedThrough, input.witnessedPosition)
        : input.completedThrough;
}

/**
 * The sequence a tracked copy's delivery waits on: none before an entry (`0`), the record's prior after an omission or
 * a gap that ended at it, `seq - 1` otherwise. Read from the observation its admission recorded on the copy's slot.
 */
export function computeALOrderingDeliveryPredecessorSeq(observation: ALOrderingObservation): number | undefined {
    const { status, seq, priorSeq, lastContiguousSeq } = observation;
    if (seq === undefined) {
        return undefined;
    }
    if (status === 'entered') {
        return 0;
    }
    if (status === 'omitted' || (status === 'gap' && priorSeq !== undefined && priorSeq > (lastContiguousSeq ?? 0))) {
        return priorSeq;
    }
    return seq - 1;
}

/** The delivered markers a committed write sets, as a capped store's marker index records them. */
export function toALInboundDeliveredMarkers(
    mutations: readonly ALInboundAdmissionMutation[]
): readonly ALInboundIndexedMarker[] {
    return mutations.flatMap((mutation) =>
        mutation.kind === 'set-delivery-progress'
            ? [{ trackKey: mutation.trackKey, expireAtTimestamp: mutation.value.expireAtTimestamp }]
            : []
    );
}
