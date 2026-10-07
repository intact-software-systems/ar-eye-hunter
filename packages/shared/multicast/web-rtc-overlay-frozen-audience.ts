import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    toALFrozenMulticastMessage,
    type ALFrozenMulticastAudience
} from '../al-contracts/al-frozen-multicast-audience.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import { resolveALOutboundStoreDurability, type ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';
import type { GroupPresenceSession } from '../api/group-types.ts';
import { Either } from '../resilience/Either.ts';
import type { OverlayMulticasterContext } from './overlay-multicast-contracts.ts';
import { computeRtcRoomSnapshotAdmission, type RtcRoomSnapshotAdmission } from './rtc-room-snapshot-admission.ts';
import { toRtcAckTrackingPlan } from './to-rtc-ack-tracking-plan.ts';

/** The room-bounded audience an origin freezes instead of the whole room: one principal's sessions, or a fixed list. */
export type RtcAudienceNarrowing =
    | Readonly<{ kind: 'principal'; principalId: string; }>
    | Readonly<{ kind: 'list'; recipientPeerIds: readonly string[]; }>;

export interface ComputeFrozenAudienceInput {
    readonly admission: Extract<RtcRoomSnapshotAdmission, { readonly kind: 'authorized'; }>;
    readonly selfPeerId: string;
    /** `undefined` freezes every authorized session of the room. */
    readonly narrowing: RtcAudienceNarrowing | undefined;
}

export function computeFrozenAudience(input: ComputeFrozenAudienceInput): ALFrozenMulticastAudience {
    const { admission, selfPeerId, narrowing } = input;
    return {
        recipientPeerIds: admission.memberSessions
            .filter((session) => session.sessionId !== selfPeerId && isNarrowedSession(session, narrowing))
            .map((session) => session.sessionId),
        snapshotVersion: admission.snapshotVersion
    };
}

/** The narrowing a principal broadcast or a listed room broadcast names in its room; a whole-room send names none. */
export function toRtcAudienceNarrowing(message: ALMessage): RtcAudienceNarrowing | undefined {
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

/** A room multicast without its frozen audience, or a principal or listed room broadcast the origin has yet to freeze. */
export function isRtcUnfrozenRoomMessage(message: ALMessage): boolean {
    return toRtcAudienceNarrowing(message) !== undefined ||
        (message.targets?.mode === 'multicast' && resolveALFrozenMulticastAudience(message.targets) === undefined);
}

/** The room multicast frozen to the admitted sessions, narrowed to a principal or a list less its excepted sessions. */
export function toRtcFrozenRoomMessage(
    message: ALMessage,
    admission: Extract<RtcRoomSnapshotAdmission, { readonly kind: 'authorized'; }>,
    selfPeerId: string
): ALMessage {
    const narrowing = toRtcAudienceNarrowing(message);
    const targets = message.targets;
    if (narrowing === undefined || targets?.mode !== 'broadcast' || targets.groupRef === undefined) {
        return toALFrozenMulticastMessage(
            message,
            computeFrozenAudience({ admission, selfPeerId, narrowing: undefined })
        );
    }
    const { groupRef, minSnapshotVersion, rosterVersion, exceptPeerIds = [] } = targets;
    const frozen = computeFrozenAudience({ admission, selfPeerId, narrowing });
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
            msg: original.targets?.mode === 'broadcast'
                ? { ...msg, targets: original.targets }
                : toUnfrozenMulticastMessage(msg),
            dropReason:
                `RTC room multicast audience of ${recipientCount} recipients exceeds the RTC room limit of ${limit}`,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}

function isNarrowedSession(session: GroupPresenceSession, narrowing: RtcAudienceNarrowing | undefined): boolean {
    switch (narrowing?.kind) {
        case undefined:
            return true;
        case 'principal':
            return session.principalId === narrowing.principalId;
        case 'list':
            return narrowing.recipientPeerIds.includes(session.sessionId);
    }
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
