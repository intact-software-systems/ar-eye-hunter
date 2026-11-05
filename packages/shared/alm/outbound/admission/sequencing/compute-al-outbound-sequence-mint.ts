import type { ALOutboundDispatchPlan } from '../../al-outbound-message-runtime.ts';
import type { ALOutboundMessageReadDto } from '../al-outbound-admission-store.ts';
import type { ALOutboundTrackPositionRow } from '../decode-al-outbound-track-position-row.ts';

/** A first admission of a plan whose outbound owns its track, and the head that track has reached; absent for none. */
export interface ALOutboundSequenceMintInput<TPrepared> {
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly trackKey: string;
    readonly head: ALOutboundTrackPositionRow | undefined;
}

/**
 * The sequence an owned track's admission takes and the head its commit writes: the next one for a message that states
 * none, or the stated one when it lies above the head. A stated sequence at or below the head would reuse a position
 * the track already sent, so its plan is the `unsupported` drop and moves nothing.
 */
export function computeALOutboundSequenceMint<TPrepared>(
    input: ALOutboundSequenceMintInput<TPrepared>
): Pick<ALOutboundMessageReadDto<TPrepared>, 'plan' | 'orderingHead'> {
    const { plan, trackKey } = input;
    const headSeq = input.head?.seq ?? 0;
    const stated = plan.msg.ordering?.seq;
    if (stated === undefined) {
        const seq = headSeq + 1;
        return {
            plan: { ...plan, msg: { ...plan.msg, ordering: { ...plan.msg.ordering, seq } } },
            orderingHead: { trackKey, seq, observedSeq: input.head?.seq }
        };
    }
    if (stated > headSeq) {
        return { plan, orderingHead: { trackKey, seq: stated, observedSeq: input.head?.seq } };
    }
    return {
        plan: {
            msg: plan.msg,
            dropReason: `Sequence ${stated} is not above sequence ${headSeq} its track ${trackKey} has reached`,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        },
        orderingHead: undefined
    };
}
