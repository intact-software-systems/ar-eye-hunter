import type { ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';

/** A recipient's position event on a track, as its committed admission decided it. */
export interface ALInboundOrderingPosition {
    readonly trackKey: string;
    readonly seq: number;
    /**
     * The prior the copy's record named for this recipient (the observation's optional `priorSeq`); `null` where that
     * field is absent: no authority recorded the copy.
     */
    readonly priorSeq: number | null;
    readonly status: 'entered' | 'omitted' | 'witnessed' | 'before-entry';
}

/**
 * The position event a committed plan states, or `null` for an admission that moved no position: a dropped plan
 * writes none, so only its `before-entry` refusal is an event, and a witness states only a copy that moved it.
 */
export function toALInboundOrderingPosition(plan: ALMessageHandlingPlan): ALInboundOrderingPosition | null {
    const { status, trackKey, seq, priorSeq, lastContiguousSeq } = plan.orderingRuntime;
    if (trackKey === undefined || seq === undefined) {
        return null;
    }
    const position = { trackKey, seq, priorSeq: priorSeq ?? null };
    if (plan.dropReason !== undefined) {
        return plan.nack.enabled && plan.nack.reason === 'before-entry'
            ? { ...position, status: 'before-entry' }
            : null;
    }
    if (status === 'entered' || status === 'omitted' || (status === 'witnessed' && lastContiguousSeq === seq)) {
        return { ...position, status };
    }
    return null;
}
