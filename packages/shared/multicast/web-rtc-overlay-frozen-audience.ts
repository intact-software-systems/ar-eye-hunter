import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    toALFrozenMulticastMessage,
    type ALFrozenMulticastAudience
} from '../al-contracts/al-frozen-multicast-audience.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';
import type { OverlayMulticasterContext } from './overlay-multicast-contracts.ts';
import { computeRtcRoomSnapshotAdmission, type RtcRoomSnapshotAdmission } from './rtc-room-snapshot-admission.ts';

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
