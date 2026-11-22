import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALRequestedAckAlgo } from '../../al-contracts/normalize-al-qos-policy.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';
import { isRtcUnfrozenRoomMessage } from '../web-rtc-overlay-frozen-audience.ts';

export interface IsRtcPublisherProofRequiredInput {
    readonly message: ALMessage;
    /** Whether the page grants the frame's topic; who may publish on it is a separate question, not asked here. */
    readonly topicGranted: boolean;
}

/**
 * Whether RTC carries a frame only with its origin's publisher proof: a publication on a granted topic, or a room send
 * -- a room multicast or a broadcast naming its room -- that asks a `receiver` or `leader` receipt (D756). The receipt
 * is the one the frame states, its `qos.ack` over its `delivery.ack`, both of which the proof signs. Its origin signs
 * such a frame once its audience is frozen, every hop verifies it before it plans it, and a relay forwards it with its
 * proof; a receipted room broadcast its origin never freezes is refused (`resolveRtcReceiptedRoomShapeRefusal`).
 */
export function isRtcPublisherProofRequired(input: IsRtcPublisherProofRequiredInput): boolean {
    const { message } = input;
    return input.topicGranted ||
        (isRtcRoomSend(message) && isALLogicalReceiptMode(resolveALRequestedAckAlgo(message) ?? 'none'));
}

/**
 * A receipted room broadcast RTC cannot sign, since its origin never freezes it into a multicast -- one that names
 * only its exclusions: it is refused as unsupported, the refusal a fallback carrier takes over; `undefined` otherwise.
 */
export function resolveRtcReceiptedRoomShapeRefusal(message: ALMessage): string | undefined {
    return message.targets?.mode === 'broadcast' && !isRtcUnfrozenRoomMessage(message) &&
            isRtcPublisherProofRequired({ message, topicGranted: false })
        ? RTC_RECEIPTED_ROOM_SHAPE_REFUSAL
        : undefined;
}

const RTC_RECEIPTED_ROOM_SHAPE_REFUSAL = 'RTC carries a receipted room send only as an audience its origin freezes.';

function isRtcRoomSend(message: ALMessage): boolean {
    const targets = message.targets;
    return targets?.mode === 'multicast' || (targets?.mode === 'broadcast' && targets.groupRef !== undefined);
}
