import {
    isALAudienceSession,
    toALLeaderNarrowing,
    type ALAudienceNarrowing
} from '../al-contracts/al-audience-narrowing.ts';
import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    toALFrozenMulticastMessage,
    type ALFrozenMulticastAudience
} from '../al-contracts/al-frozen-multicast-audience.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import { resolveALOutboundStoreDurability, type ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
import { isALLogicalReceiptMode } from '../al-contracts/validate-al-ack-support.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';
import { Either } from '../resilience/Either.ts';
import type { OverlayMulticasterContext } from './overlay-multicast-contracts.ts';
import { computeRtcRoomSnapshotAdmission, type RtcRoomSnapshotAdmission } from './rtc-room-snapshot-admission.ts';
import { toRtcAckTrackingPlan } from './to-rtc-ack-tracking-plan.ts';

export interface ComputeFrozenAudienceInput {
    readonly admission: Extract<RtcRoomSnapshotAdmission, { readonly kind: 'authorized'; }>;
    readonly selfPeerId: string;
    /** `undefined` freezes every authorized session of the room. */
    readonly narrowing: ALAudienceNarrowing | undefined;
    /** The room's leader inside that audience, for a `group-leader` send; `undefined` for any other. */
    readonly leader: ALAudienceNarrowing | undefined;
}

export function computeFrozenAudience(input: ComputeFrozenAudienceInput): ALFrozenMulticastAudience {
    const { admission, selfPeerId, narrowing, leader } = input;
    return {
        recipientPeerIds: admission.memberSessions
            .filter((session) =>
                session.sessionId !== selfPeerId && isALAudienceSession(session, narrowing) &&
                isALAudienceSession(session, leader)
            )
            .map((session) => session.sessionId),
        snapshotVersion: admission.snapshotVersion
    };
}

export function toRtcAudienceNarrowing(message: ALMessage): ALAudienceNarrowing | undefined {
    const targets = message.targets;
    if (targets?.mode !== 'broadcast' || targets.groupRef === undefined) {
        return undefined;
    }
    if (targets.scope === 'principal' && targets.principalRef !== undefined) {
        return { kind: 'principal', principalId: targets.principalRef.principalId };
    }
    return targets.scope === 'room' && targets.recipientPeerIds !== undefined
        ? { kind: 'list', recipientPeerIds: targets.recipientPeerIds }
        : undefined;
}

/**
 * RTC carries room audiences only. A world or all broadcast, or a principal broadcast that names no room, is
 * refused as unsupported: the refusal a fallback carrier takes over, and the verdict of an RTC-only send.
 */
export function computeRtcBroadcastScopeRefusal(
    msg: ALMessage
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    const targets = msg.targets;
    return targets?.mode !== 'broadcast' || targets.scope === 'room' || toRtcAudienceNarrowing(msg) !== undefined
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg,
            dropReason: `RTC carries room audiences only: a ${targets.scope} broadcast is unsupported`,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}

/**
 * The origin freezes its own room send once, from the sessions its room authority admits at the first plan that
 * has one: a message that already carries its audience keeps it on every later attempt, whatever the room has
 * become since. A principal or listed room broadcast is frozen as the room multicast of its narrowed audience; until
 * then it waits for its room like any unfrozen multicast, and is never sent unfrozen.
 */
export function toRtcOriginFrozenMessage(
    message: ALMessage,
    context: OverlayMulticasterContext | undefined,
    selfPeerId: string
): ALMessage {
    if (context === undefined || message.id.senderId !== selfPeerId || !isRtcUnfrozenRoomMessage(message)) {
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
    return admission.kind === 'authorized' ? toRtcFrozenRoomMessage(message, admission, selfPeerId) : message;
}

/** A room broadcast that names its own audience, or addresses its room's leader, is frozen as a multicast. */
export function isRtcUnfrozenRoomMessage(message: ALMessage): boolean {
    const targets = message.targets;
    return toRtcAudienceNarrowing(message) !== undefined ||
        (targets?.mode === 'broadcast' && targets.scope === 'room' && targets.groupRef !== undefined &&
            message.delivery?.ack === 'group-leader') ||
        (targets?.mode === 'multicast' && resolveALFrozenMulticastAudience(targets) === undefined);
}

export function toRtcFrozenRoomMessage(
    message: ALMessage,
    admission: Extract<RtcRoomSnapshotAdmission, { readonly kind: 'authorized'; }>,
    selfPeerId: string
): ALMessage {
    const frozen = computeFrozenAudience({
        admission,
        selfPeerId,
        narrowing: toRtcAudienceNarrowing(message),
        leader: toALLeaderNarrowing(message, admission.leaderSessionId)
    });
    const targets = message.targets;
    if (targets?.mode !== 'broadcast' || targets.groupRef === undefined) {
        return toALFrozenMulticastMessage(message, frozen);
    }
    const { groupRef, minSnapshotVersion, rosterVersion, exceptPeerIds = [] } = targets;
    return {
        ...message,
        targets: {
            mode: 'multicast',
            groupRef,
            minSnapshotVersion,
            rosterVersion,
            recipientPeerIds: frozen.recipientPeerIds.filter((peerId) => !exceptPeerIds.includes(peerId)),
            snapshotVersion: frozen.snapshotVersion
        }
    };
}

/**
 * The RTC room limit: the frozen audience rides on the wire, where one collection holds at most
 * `collectionEntries` ids. A larger audience is refused as unsupported, the refusal a fallback carrier
 * takes over, and WS carries its audience off the wire (R-S2c-ii-13). The refusal names the message
 * without the audience it could not carry, so the admission can still read it: a frozen principal or listed
 * broadcast is named with the targets its sender gave, so the fallback keeps its narrowed audience.
 */
export function computeRtcFrozenAudienceRefusal(
    msg: ALMessage,
    original: ALMessage
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    const recipientCount = resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds.length ?? 0;
    const limit = AL_MESSAGE_RESOURCE_LIMITS.collectionEntries;
    return recipientCount <= limit
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg: toUnfrozenRoomMessage(msg, original),
            dropReason:
                `RTC room multicast audience of ${recipientCount} recipients exceeds the RTC room limit of ${limit}`,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}

/**
 * A `group-leader` room send frozen to no session has no leader to confirm it: the room appoints no director present
 * at admission, the sender is the director, or the audience its sender names leaves the director out (D165). It is
 * refused, never handed to another carrier, which reads the same room.
 */
export function computeRtcLeaderRefusal(
    msg: ALMessage,
    original: ALMessage
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    const frozen = resolveALFrozenMulticastAudience(msg.targets);
    return msg.delivery?.ack !== 'group-leader' || frozen?.recipientPeerIds.length !== 0
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg: toUnfrozenRoomMessage(msg, original),
            dropReason: 'no-leader: the room has no active leader inside the audience the send names',
            dropReasonCode: 'no-leader',
            lane: 'volatile',
            preparedMessages: []
        });
}

function toUnfrozenRoomMessage(msg: ALMessage, original: ALMessage): ALMessage {
    return original.targets?.mode === 'broadcast'
        ? { ...msg, targets: original.targets }
        : toUnfrozenMulticastMessage(msg);
}

function toUnfrozenMulticastMessage(msg: ALMessage): ALMessage {
    if (msg.targets?.mode !== 'multicast') {
        return msg;
    }
    const { recipientPeerIds, snapshotVersion, ...targets } = msg.targets;
    return recipientPeerIds === undefined && snapshotVersion === undefined ? msg : { ...msg, targets };
}

/**
 * Under `receiver` and `leader` the origin's receipt counts the frozen logical recipients, not the next hops a plan
 * reaches, so every plan of its own frozen multicast expects exactly that audience.
 */
export function toRtcFrozenAudienceDispatchPlan(
    plan: ALOutboundDispatchPlan<ALOutboundTransportMessage>,
    selfPeerId: string
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const frozen = resolveALFrozenMulticastAudience(plan.msg.targets);
    if (
        plan.ackTracking === undefined || !isALLogicalReceiptMode(plan.ackTracking.mode) || frozen === undefined ||
        plan.msg.id.senderId !== selfPeerId
    ) {
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
 * Its store is the one its durability names, like any other send of the origin.
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
        lane: resolveALOutboundStoreDurability(effective.durability.algo),
        msg: plan.msg,
        preparedMessages: [],
        ackTracking: toRtcAckTrackingPlan(effective, [])
    };
}
