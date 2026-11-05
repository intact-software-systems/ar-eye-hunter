import type { ALOrderingObservation } from '../../../al-contracts/al-runtime.ts';

export interface ALInboundDeliveryCompletionInput {
    readonly completedThrough: number;
    readonly seq: number;
    /** The observation the copy's admission recorded on its slot. */
    readonly observation: ALOrderingObservation;
}

/** A delivery completes the track through its own sequence once its predecessor completed. */
export function canALInboundDeliveryComplete(input: ALInboundDeliveryCompletionInput): boolean {
    const predecessorSeq = computeALOrderingDeliveryPredecessorSeq(input.observation) ?? input.seq - 1;
    return input.seq > input.completedThrough && predecessorSeq <= input.completedThrough;
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
