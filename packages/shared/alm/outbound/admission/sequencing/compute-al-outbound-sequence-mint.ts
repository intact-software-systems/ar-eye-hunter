import { isALLogicalReceiptMode } from '../../../../al-contracts/validate-al-ack-support.ts';
import type { ALOutboundDispatchPlan } from '../../al-outbound-message-runtime.ts';
import type { ALOutboundMessageReadDto, ALOutboundOrderingHead } from '../al-outbound-admission-store.ts';
import type { ALOutboundTrackPositionRow } from '../decode-al-outbound-track-position-row.ts';
import {
    computeALOutboundRoomSentFloorMint,
    type ALOutboundRoomSentFloorRow
} from './al-outbound-room-sent-floor.ts';

/** A first admission of a plan whose outbound owns its track, and the head that track has reached; absent for none. */
export interface ALOutboundSequenceMintInput<TPrepared> {
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly trackKey: string;
    readonly head: ALOutboundTrackPositionRow | undefined;
    /** The track's room-wide sent position on a shared head; undefined for none, or a head the pair does not share. */
    readonly roomFloor: ALOutboundRoomSentFloorRow | undefined;
    /** Another carrier pair of the session mints on the same head. */
    readonly sharesHead: boolean;
}

/**
 * The sequence an owned track's admission takes and the head its commit writes: the next one for a message that states
 * none, or the stated one when it lies above the head. A stated sequence at or below the head would reuse a position
 * the track already sent, so its plan is the `unsupported` drop and moves nothing.
 */
export function computeALOutboundSequenceMint<TPrepared>(
    input: ALOutboundSequenceMintInput<TPrepared>
): Pick<ALOutboundMessageReadDto<TPrepared>, 'plan' | 'orderingHead'> {
    const { plan } = input;
    const headSeq = input.head?.seq ?? 0;
    const stated = plan.msg.ordering?.seq;
    if (stated === undefined) {
        const seq = headSeq + 1;
        return {
            plan: { ...plan, msg: { ...plan.msg, ordering: { ...plan.msg.ordering, seq } } },
            orderingHead: toALOutboundMintedHead(input, seq)
        };
    }
    if (stated > headSeq) {
        return { plan, orderingHead: toALOutboundMintedHead(input, stated) };
    }
    return {
        plan: {
            msg: plan.msg,
            dropReason: `Sequence ${stated} is not above sequence ${headSeq} its track ${input.trackKey} has reached`,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        },
        orderingHead: undefined
    };
}

/**
 * On a shared head, a plan that records no recipient adds its sequence to the track's room-wide sent position: one an
 * `admitted` receipt of this pair will name the audience of (a logical receipt mode), or else one no receipt answers.
 */
function toALOutboundMintedHead<TPrepared>(
    input: ALOutboundSequenceMintInput<TPrepared>,
    seq: number
): ALOutboundOrderingHead {
    const { plan, roomFloor } = input;
    const receipted = plan.ackTracking !== undefined && isALLogicalReceiptMode(plan.ackTracking.mode);
    return {
        trackKey: input.trackKey,
        seq,
        observedSeq: input.head?.seq,
        roomSentFloor: input.sharesHead && plan.recordsSentPositions === undefined
            ? { observed: roomFloor, value: computeALOutboundRoomSentFloorMint(roomFloor, seq, receipted) }
            : undefined
    };
}
