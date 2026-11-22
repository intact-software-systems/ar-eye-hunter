import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { isALFrozenMulticastRecipient } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import type { ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';
import { resolveALOrderingPriorSeq } from '../../../al-contracts/al-runtime.ts';

/** A recorded copy at a fresh recipient, and what the copy's plan says about asking for what came before it. */
export interface ALOrderingTrackStartInput {
    readonly msg: ALMessage;
    readonly selfPeerId: string;
    /** Whether the store evicted the track's snapshot at its cap: a position it forgot, not one it never held. */
    readonly evictedTrack: boolean;
    /** Whether the copy's plan supersedes by latest-wins: a predecessor it replaced was never owed to anyone. */
    readonly latestWins: boolean;
    /** Whether the copy's plan repairs gaps: one that repairs none plans no gap NACK, so it can never ask for a start. */
    readonly repairsGaps: boolean;
}

/** A copy as its plan admits it at a recipient, and whether the store evicted the copy's track. */
export interface ToALOrderingTrackStartInput {
    readonly msg: ALMessage;
    readonly plan: ALMessageHandlingPlan;
    readonly selfPeerId: string;
    readonly evictedTrack: boolean;
}

/** What the copy's plan says about asking for the sends before it: whether it repairs gaps and supersedes by latest-wins. */
export function toALOrderingTrackStartInput(input: ToALOrderingTrackStartInput): ALOrderingTrackStartInput {
    return {
        msg: input.msg,
        selfPeerId: input.selfPeerId,
        evictedTrack: input.evictedTrack,
        latestWins: input.plan.supersedence.algo === 'latest-wins',
        repairsGaps: input.plan.effective.repair.algo !== 'none'
    };
}

/**
 * Whether a copy's record owes a recipient with no live position the track's start: the sends below its prior are owed
 * and still repairable, so the recipient opens the track at position 0 instead of entering at the copy. The record
 * speaks only for the copy's frozen audience, so a peer it does not name (the WS server, ordering hop of every track)
 * is owed nothing, and neither is one whose copy's plan repairs no gap, since it could never ask for the start, one
 * whose track the store evicted at its cap, since its delivered past is forgotten, not absent, nor one of a latest-wins
 * copy, whose predecessor may have been superseded before it was ever sent.
 */
export function isALOrderingTrackStartOwed(input: ALOrderingTrackStartInput): boolean {
    const seq = input.msg.ordering?.seq;
    if (seq === undefined) {
        return false;
    }
    const prior = { priorSeq: resolveALOrderingPriorSeq(input.msg, input.selfPeerId), lastContiguousSeq: 0, seq };
    return isALOrderingInformativePrior(prior) && prior.priorSeq <= AL_MESSAGE_RESOURCE_LIMITS.repairWindow &&
        isALFrozenMulticastRecipient(input.msg.targets, input.selfPeerId) && input.repairsGaps && !input.evictedTrack &&
        !input.latestWins;
}

/** A recipient's position on a track, and a copy above it with the prior its record names, if any. */
export interface ALOrderingPriorInput {
    readonly priorSeq: number | undefined;
    readonly lastContiguousSeq: number;
    readonly seq: number;
}

/** A prior that names sends between the position and the copy: one at the position or above it, below the copy. */
export function isALOrderingInformativePrior(
    input: ALOrderingPriorInput
): input is ALOrderingPriorInput & { readonly priorSeq: number; } {
    const { priorSeq, lastContiguousSeq, seq } = input;
    return priorSeq !== undefined && priorSeq > 0 && priorSeq >= lastContiguousSeq && priorSeq < seq;
}
