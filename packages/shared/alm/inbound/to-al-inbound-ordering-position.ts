import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';

/** A recipient's position event on a track, as its committed admission decided it. */
export interface ALInboundOrderingPosition {
    readonly trackKey: string;
    readonly seq: number;
    /** The prior the copy's record named for this recipient; `null` when no authority recorded the copy. */
    readonly priorSeq: number | null;
    readonly status: 'entered' | 'omitted' | 'witnessed' | 'before-entry';
}

/** The position event a committed plan states, or `null` for an admission that moved no position of note. */
export function toALInboundOrderingPosition(plan: ALMessageHandlingPlan): ALInboundOrderingPosition | null {
    const { status, trackKey, seq, priorSeq } = plan.orderingRuntime;
    if (trackKey === undefined || seq === undefined) {
        return null;
    }
    const position = { trackKey, seq, priorSeq: priorSeq ?? null };
    if (status === 'entered' || status === 'omitted' || status === 'witnessed') {
        return { ...position, status };
    }
    return plan.nack.enabled && plan.nack.reason === 'before-entry' ? { ...position, status: 'before-entry' } : null;
}
