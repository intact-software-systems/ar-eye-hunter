import {
    isRoomScopedALMessage,
    readALTargetGroupRef,
    type ALMessage
} from '../../al-contracts/al-contract.ts';
import { resolveALAdmittedRoomAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALMessageDropReasonCode, ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';
import type { OverlayInfo } from '../../api/api-config.ts';
import { isSameGroupRef } from '../../api/api-type-utils.ts';
import { resolveRallarGroupLeaderSessionId } from '../../api/group-director.ts';
import type { GroupPresenceSession, GroupRef, GroupSnapshot } from '../../api/group-types.ts';
import type { Either } from '../../resilience/Either.ts';
import type {
    RtcPublicationAdmitted,
    RtcPublicationRefusal
} from '../publication/compute-rtc-publication-admission.ts';
import { resolveRtcRoomEdgeDenial } from './resolve-rtc-room-edge-denial.ts';
import {
    resolveRtcRoomPeerDenial,
    resolveRtcRoomRosterPosition,
    resolveRtcRoomSenderDenial,
    type RtcRoomAuthorityDenial,
    type RtcRoomRosterPosition,
    type RtcRoomSessionObservation
} from './resolve-rtc-room-peer-denial.ts';
import {
    resolveRtcRoomRoutingEdges,
    type RtcRoomLayoutEdges,
    type RtcRoomLayoutHistory,
    type RtcRoomRoutingEdges
} from './resolve-rtc-room-routing-edges.ts';

export interface RtcRoomSnapshotAdmissionInput {
    readonly message: ALMessage;
    readonly snapshot: GroupSnapshot | undefined;
    readonly overlay: OverlayInfo | undefined;
    readonly layoutHistory: RtcRoomLayoutHistory;
    readonly selfPeerId: string;
    readonly fromPeerId: string | undefined;
    readonly recipientPeerId: string | undefined;
    readonly nowMs: number;
}

export type RtcRoomSnapshotAdmission =
    | { readonly kind: 'not-room'; }
    | {
        readonly kind: 'authorized';
        /** The authorized sessions now: the tree a relay forwards over, a late joiner included. */
        readonly memberPeerIds: readonly string[];
        /** The same sessions with their principals, from which an origin narrows a principal audience. */
        readonly memberSessions: readonly GroupPresenceSession[];
        readonly forwardingPeerIds: readonly string[];
        /**
         * The replaced layout's edges a sender and a relay also forward over, only in the first half of the overlap
         * this receiver admits; else `null`.
         */
        readonly previousForwarding: RtcRoomLayoutEdges | null;
        readonly snapshotVersion: number;
        /** The room's leader the snapshot appoints and holds present, to which a `group-leader` send narrows. */
        readonly leaderSessionId: string | undefined;
        /** Only a session of the frozen audience delivers locally and counts as a logical recipient. */
        readonly deliversLocally: boolean;
    }
    | RtcRoomAuthorityDenial;

export interface RtcRoomSnapshotHandlingInput extends RtcRoomSnapshotAdmissionInput {
    readonly plan: ALMessageHandlingPlan;
}

interface RtcRoomAdmissionAuthority extends RtcRoomSessionObservation {
    readonly authorizedSessions: readonly GroupPresenceSession[];
    readonly authorizedPeerIds: readonly string[];
    readonly routingEdges: RtcRoomRoutingEdges;
}

const NO_RTC_ROOM_ROUTING_EDGES: RtcRoomRoutingEdges = {
    accepted: { neighbourPeerIds: [], nextHopsBySessionId: undefined },
    previous: null,
    admittedEdgePeerIds: [],
    awaitedEdgePeerIds: []
};

interface RtcRoomRefusal {
    readonly code: Extract<ALMessageDropReasonCode, 'not-yet-in-sync' | 'membership-fenced' | 'unauthorized'>;
    readonly dropReason: string;
}

export function computeRtcRoomSnapshotAdmission(input: RtcRoomSnapshotAdmissionInput): RtcRoomSnapshotAdmission {
    if (!isRoomScopedALMessage(input.message)) {
        return { kind: 'not-room' };
    }
    const roomRef = readALTargetGroupRef(input.message);
    if (!roomRef) {
        return {
            kind: 'unauthorized',
            cause: 'authority-rejected',
            reason: 'Room messages require a scoped group reference'
        };
    }
    const snapshot = input.snapshot;
    if (!snapshot) {
        return { kind: 'pending', cause: 'authority-behind', reason: 'Awaiting a room authority observation' };
    }
    const authority = toRtcRoomAdmissionAuthority(input, roomRef, snapshot);
    const senderRoster = input.fromPeerId === undefined
        ? undefined
        : resolveRtcRoomRosterPosition(input.message, snapshot);
    return resolveRoomObservationDenial(roomRef, snapshot, input.nowMs) ??
        resolveRoomAuthorityDenial(input, authority, senderRoster) ??
        resolveRoomFloorDenial(input, snapshot, senderRoster) ??
        toAuthorizedRoomAdmission(input, authority, snapshot);
}

function toRtcRoomAdmissionAuthority(
    input: RtcRoomSnapshotAdmissionInput,
    roomRef: GroupRef,
    snapshot: GroupSnapshot
): RtcRoomAdmissionAuthority {
    const observation = {
        roomRef,
        nowMs: input.nowMs,
        sessions: new Map(snapshot.activeSessions.map((session) => [session.sessionId, session])),
        members: new Map(snapshot.members.map((member) => [member.principalId, member]))
    };
    const authorizedSessions = snapshot.activeSessions.filter((session) =>
        resolveRtcRoomPeerDenial(observation, session.sessionId) === undefined
    );
    const authorizedPeerIds = authorizedSessions.map((session) => session.sessionId);
    const routingEdges = input.overlay === undefined ? NO_RTC_ROOM_ROUTING_EDGES : resolveRtcRoomRoutingEdges({
        roomRef,
        accepted: input.overlay,
        history: input.layoutHistory,
        authorizedPeerIds,
        nowMs: input.nowMs
    });
    return { ...observation, authorizedSessions, authorizedPeerIds, routingEdges };
}

export function planRtcRoomSnapshotAdmission(input: RtcRoomSnapshotHandlingInput): ALMessageHandlingPlan {
    return toRtcRoomSnapshotHandlingPlan(input.plan, computeRtcRoomSnapshotAdmission(input), input.fromPeerId);
}

export function toRtcRoomSnapshotHandlingPlan(
    plan: ALMessageHandlingPlan,
    admission: RtcRoomSnapshotAdmission,
    fromPeerId: string | undefined
): ALMessageHandlingPlan {
    if (admission.kind === 'authorized') {
        return admission.deliversLocally ? plan : toForwardOnlyHandlingPlan(plan);
    }
    if (admission.kind === 'not-room' || plan.dropReasonCode === 'expired') {
        return plan;
    }
    return toRtcRefusedHandlingPlan(plan, toRtcRoomRefusal(admission), fromPeerId);
}

/**
 * The publication admission of a granted frame, or of a proof frame on an ungranted topic, on a plan its room admission
 * authorized or on the plan of a frame with no readable snapshot; a frame its room refused never reaches it. A key or
 * authority the receiver has not yet observed is not yet in sync, which the receiver's one-shot room refresh answers;
 * every other refusal is unauthorized, with no NACK and no forward.
 */
export function toRtcPublicationHandlingPlan(
    plan: ALMessageHandlingPlan,
    admission: Either<RtcPublicationRefusal, RtcPublicationAdmitted>,
    fromPeerId: string | undefined
): ALMessageHandlingPlan {
    return admission.fold(
        (refusal) =>
            plan.dropReasonCode === 'expired'
                ? plan
                : toRtcRefusedHandlingPlan(plan, toRtcPublicationRefusal(refusal), fromPeerId),
        (admitted) => toRtcPublicationDeliveryPlan(plan, admitted.delivery, fromPeerId)
    );
}

function toRtcPublicationDeliveryPlan(
    plan: ALMessageHandlingPlan,
    delivery: RtcPublicationAdmitted['delivery'],
    fromPeerId: string | undefined
): ALMessageHandlingPlan {
    switch (delivery) {
        case 'deliver':
            return plan;
        case 'forward-only':
            return toForwardOnlyHandlingPlan(plan);
        case 'forward-not-subscribed':
            return toNotSubscribedHandlingPlan(plan, fromPeerId);
    }
}

/**
 * A frozen recipient that delivers nothing tells its hop so, toward the origin that counts it, and ends its hop with
 * an ACK that confirms no recipient. Only a receipt that counts recipients asks; a plan that drops with a NACK of its
 * own keeps that NACK.
 */
function toNotSubscribedHandlingPlan(
    plan: ALMessageHandlingPlan,
    fromPeerId: string | undefined
): ALMessageHandlingPlan {
    const forwardOnly = toForwardOnlyHandlingPlan(plan);
    if (!isALLogicalReceiptMode(plan.ack.algo) || fromPeerId === undefined || (plan.dropReason && plan.nack.enabled)) {
        return forwardOnly;
    }
    return {
        ...forwardOnly,
        ack: plan.dropReason === undefined ? { ...plan.ack, enabled: true } : plan.ack,
        nack: { enabled: true, toPeerId: fromPeerId, reason: 'not-subscribed', missingRanges: [] }
    };
}

function toRtcRefusedHandlingPlan(
    plan: ALMessageHandlingPlan,
    refusal: RtcRoomRefusal,
    fromPeerId: string | undefined
): ALMessageHandlingPlan {
    return {
        ...plan,
        dropReason: refusal.dropReason,
        dropReasonCode: refusal.code,
        localDelivery: { enabled: false, persist: false, deferred: false },
        forwarding: { enabled: false, persist: false, nextHopPeerIds: [] },
        ack: { enabled: false, algo: 'none', deferred: false },
        nack: {
            enabled: refusal.code !== 'unauthorized' && fromPeerId !== undefined,
            toPeerId: fromPeerId,
            reason: refusal.code,
            missingRanges: []
        },
        repair: { enabled: false, algo: 'none' }
    };
}

function toRtcPublicationRefusal(refusal: RtcPublicationRefusal): RtcRoomRefusal {
    return refusal.code === 'unknown-key' || refusal.code === 'authority-ahead'
        ? { code: 'not-yet-in-sync', dropReason: `not-yet-in-sync: ${refusal.code}` }
        : { code: 'unauthorized', dropReason: `unauthorized: ${refusal.code}` };
}

/**
 * The detail names which denial fired; the code stays at its head because `dropReason` is
 * what the inbound acceptance carries, and the receiver's room-authority refresh reads it.
 */
function toRtcRoomRefusal(denial: RtcRoomAuthorityDenial): RtcRoomRefusal {
    if (denial.kind === 'pending') {
        return { code: 'not-yet-in-sync', dropReason: `not-yet-in-sync: ${denial.reason}` };
    }
    return denial.cause === 'membership-fenced'
        ? { code: 'membership-fenced', dropReason: `membership-fenced: ${denial.reason}` }
        : { code: 'unauthorized', dropReason: 'unauthorized' };
}

/**
 * An unauthorized denial outranks a pending one, so a fenced sender is refused even while another peer is awaited. A
 * copy at ingress has a sender roster position, and its sender is judged on that roster; the origin's sender is a peer.
 */
function resolveRoomAuthorityDenial(
    input: RtcRoomSnapshotAdmissionInput,
    authority: RtcRoomAdmissionAuthority,
    senderRoster: RtcRoomRosterPosition | undefined
): RtcRoomAuthorityDenial | undefined {
    const senderId = input.message.id.senderId;
    const otherPeerIds = new Set(
        [input.selfPeerId, input.fromPeerId, input.recipientPeerId].filter((peerId): peerId is string =>
            peerId !== undefined && peerId !== senderId
        )
    );
    const denials = [
        senderRoster === undefined
            ? resolveRtcRoomPeerDenial(authority, senderId)
            : resolveRtcRoomSenderDenial(authority, senderId, senderRoster),
        ...Array.from(otherPeerIds, (peerId) => resolveRtcRoomPeerDenial(authority, peerId)),
        resolveRtcRoomEdgeDenial(input, authority)
    ];
    return denials.find((candidate) => candidate?.kind === 'unauthorized') ??
        denials.find((candidate) => candidate !== undefined);
}

/** The target floors apply at receiver/relay ingress; the origin's own authority is checked above. */
function resolveRoomFloorDenial(
    input: RtcRoomSnapshotAdmissionInput,
    snapshot: GroupSnapshot,
    senderRoster: RtcRoomRosterPosition | undefined
): RtcRoomAuthorityDenial | undefined {
    if (input.fromPeerId === undefined) {
        return undefined;
    }
    const targets = input.message.targets;
    const floor = targets && targets.mode !== 'unicast' ? targets.minSnapshotVersion : undefined;
    if (floor !== undefined && snapshot.group.snapshotVersion < floor) {
        return { kind: 'pending', cause: 'authority-behind', reason: 'Awaiting the required room snapshot version' };
    }
    if (senderRoster === 'behind') {
        return { kind: 'pending', cause: 'authority-behind', reason: 'Awaiting the required room roster version' };
    }
    return undefined;
}

function toAuthorizedRoomAdmission(
    input: RtcRoomSnapshotAdmissionInput,
    authority: RtcRoomAdmissionAuthority,
    snapshot: GroupSnapshot
): RtcRoomSnapshotAdmission {
    const { authorizedSessions, authorizedPeerIds, routingEdges } = authority;
    return {
        kind: 'authorized',
        memberPeerIds: authorizedPeerIds,
        memberSessions: authorizedSessions,
        forwardingPeerIds: routingEdges.accepted.neighbourPeerIds,
        previousForwarding: routingEdges.previous,
        snapshotVersion: snapshot.group.snapshotVersion,
        leaderSessionId: resolveRallarGroupLeaderSessionId(snapshot),
        deliversLocally: resolveALAdmittedRoomAudience(input.message, authorizedPeerIds).includes(input.selfPeerId)
    };
}

/**
 * A session outside the frozen audience still forwards along the tree, but never delivers the message
 * and never counts as one of its logical recipients; its ACK only completes its hop.
 */
function toForwardOnlyHandlingPlan(plan: ALMessageHandlingPlan): ALMessageHandlingPlan {
    return { ...plan, localDelivery: { ...plan.localDelivery, enabled: false, deferred: false } };
}

/** The snapshot's own observability: the room it names, active and unexpired at `nowMs`. */
export function resolveRoomObservationDenial(
    roomRef: GroupRef,
    snapshot: GroupSnapshot,
    nowMs: number
): RtcRoomAuthorityDenial | undefined {
    if (!isSameGroupRef(snapshot.group, roomRef)) {
        return { kind: 'unauthorized', cause: 'authority-rejected', reason: 'Room authority belongs to another scope' };
    }
    if (
        snapshot.group.status !== 'active' ||
        (snapshot.group.expiresAtEpochMs !== null && snapshot.group.expiresAtEpochMs <= nowMs)
    ) {
        return { kind: 'unauthorized', cause: 'authority-rejected', reason: 'Room authority is inactive or expired' };
    }
    return undefined;
}
