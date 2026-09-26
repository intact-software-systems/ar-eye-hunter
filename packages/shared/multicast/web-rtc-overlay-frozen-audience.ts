import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    toALFrozenMulticastMessage,
    type ALFrozenMulticastAudience
} from '../al-contracts/al-frozen-multicast-audience.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import type { ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';
import { Either } from '../resilience/Either.ts';
import type { OverlayMulticasterContext } from './overlay-multicast-contracts.ts';
import { computeRtcRoomSnapshotAdmission, type RtcRoomSnapshotAdmission } from './rtc-room-snapshot-admission.ts';
import { toRtcAckTrackingPlan } from './to-rtc-ack-tracking-plan.ts';

export interface ComputeFrozenAudienceInput {
    readonly admission: Extract<RtcRoomSnapshotAdmission, { readonly kind: 'authorized'; }>;
    readonly selfPeerId: string;
}

export function computeFrozenAudience(input: ComputeFrozenAudienceInput): ALFrozenMulticastAudience {
    return {
        recipientPeerIds: input.admission.memberPeerIds.filter((peerId) => peerId !== input.selfPeerId),
        snapshotVersion: input.admission.snapshotVersion
    };
}

/**
 * The origin freezes its own room multicast once, from the sessions its room authority admits at the first
 * plan that has one: a message that already carries its audience keeps it on every later attempt, whatever
 * the room has become since.
 */
export function toRtcOriginFrozenMessage(
    message: ALMessage,
    context: OverlayMulticasterContext | undefined,
    selfPeerId: string
): ALMessage {
    if (
        context === undefined || message.id.senderId !== selfPeerId || message.targets?.mode !== 'multicast' ||
        resolveALFrozenMulticastAudience(message.targets) !== undefined
    ) {
        return message;
    }
    const admission = computeRtcRoomSnapshotAdmission({
        message,
        snapshot: context.room,
        overlay: context.overlay,
        selfPeerId,
        fromPeerId: undefined,
        recipientPeerId: undefined,
        nowMs: context.nowMs
    });
    return admission.kind === 'authorized'
        ? toALFrozenMulticastMessage(message, computeFrozenAudience({ admission, selfPeerId }))
        : message;
}

/**
 * The RTC room limit: the frozen audience rides on the wire, where one collection holds at most
 * `collectionEntries` ids. A larger audience is refused as unsupported, the refusal a fallback carrier
 * takes over, and WS carries its audience off the wire (R-S2c-ii-13). The refusal names the message
 * without the audience it could not carry, so the admission can still read it.
 */
export function computeRtcFrozenAudienceRefusal(
    msg: ALMessage
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    const recipientCount = resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds.length ?? 0;
    const limit = AL_MESSAGE_RESOURCE_LIMITS.collectionEntries;
    return recipientCount <= limit
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg: toUnfrozenMulticastMessage(msg),
            dropReason:
                `RTC room multicast audience of ${recipientCount} recipients exceeds the RTC room limit of ${limit}`,
            dropReasonCode: 'unsupported',
            persist: false,
            preparedMessages: []
        });
}

function toUnfrozenMulticastMessage(msg: ALMessage): ALMessage {
    if (msg.targets?.mode !== 'multicast') {
        return msg;
    }
    const { recipientPeerIds, snapshotVersion, ...targets } = msg.targets;
    return recipientPeerIds === undefined && snapshotVersion === undefined ? msg : { ...msg, targets };
}

/**
 * Under `receiver` the origin's receipt counts the frozen logical recipients, not the next hops a plan
 * reaches, so every plan of its own frozen multicast expects exactly that audience.
 */
export function toRtcFrozenAudienceDispatchPlan(
    plan: ALOutboundDispatchPlan<ALOutboundTransportMessage>,
    selfPeerId: string
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const frozen = resolveALFrozenMulticastAudience(plan.msg.targets);
    if (plan.ackTracking?.mode !== 'receiver' || frozen === undefined || plan.msg.id.senderId !== selfPeerId) {
        return plan;
    }
    return { ...plan, ackTracking: { ...plan.ackTracking, expectedPeerIds: frozen.recipientPeerIds } };
}

export function toRtcFrozenAudienceRepairPlan(
    plan: ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined,
    selfPeerId: string
): ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined {
    return plan === undefined ? undefined : toRtcFrozenAudienceDispatchPlan(plan, selfPeerId);
}

/**
 * An origin alone in its room freezes an empty audience. Its `receiver` send has no copy to plan, yet
 * it is admitted: the receipt of zero recipients is complete at once, as the WS server answers it.
 */
export function toRtcEmptyAudienceDispatchPlan(
    plan: ALOutboundDispatchPlan<ALOutboundTransportMessage>,
    effective: ALQosEffectivePolicy
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const frozen = resolveALFrozenMulticastAudience(plan.msg.targets);
    if (
        frozen?.recipientPeerIds.length !== 0 || effective.ack.algo !== 'receiver' ||
        (plan.dropReasonCode !== 'no-route' && plan.dropReasonCode !== 'planner-drop')
    ) {
        return plan;
    }
    return {
        dropReasonCode: undefined,
        persist: true,
        msg: plan.msg,
        preparedMessages: [],
        ackTracking: toRtcAckTrackingPlan(effective, [])
    };
}
