import {
    isRoomScopedALMessage,
    readALTargetGroupRef,
    type ALMessage
} from '../al-contracts/al-contract.ts';
import { resolveALAdmittedRoomAudience } from '../al-contracts/al-frozen-multicast-audience.ts';
import type { ALMessageDropReasonCode, ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import type { OverlayInfo } from '../api/api-config.ts';
import { isSameGroupRef } from '../api/api-type-utils.ts';
import type { GroupPresenceSession, GroupRef, GroupSnapshot } from '../api/group-types.ts';
import { isRoomLayoutOverlay } from '../repository/is-accepted-room-layout-overlay.ts';
import {
    resolveRtcRoomPeerDenial,
    resolveRtcRoomRosterPosition,
    resolveRtcRoomSenderDenial,
    type RtcRoomAuthorityDenial,
    type RtcRoomRosterPosition,
    type RtcRoomSessionObservation
} from './resolve-rtc-room-peer-denial.ts';

export interface RtcRoomSnapshotAdmissionInput {
    readonly message: ALMessage;
    readonly snapshot: GroupSnapshot | undefined;
    readonly overlay: OverlayInfo | undefined;
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
        readonly snapshotVersion: number;
        /** Only a session of the frozen audience delivers locally and counts as a logical recipient. */
        readonly deliversLocally: boolean;
    }
    | RtcRoomAuthorityDenial;

export interface RtcRoomSnapshotHandlingInput extends RtcRoomSnapshotAdmissionInput {
    readonly plan: ALMessageHandlingPlan;
}

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
        return { kind: 'pending', reason: 'Awaiting a room authority observation' };
    }
    const authority = {
        roomRef,
        nowMs: input.nowMs,
        sessions: new Map(snapshot.activeSessions.map((session) => [session.sessionId, session])),
        members: new Map(snapshot.members.map((member) => [member.principalId, member]))
    };
    const senderRoster = input.fromPeerId === undefined
        ? undefined
        : resolveRtcRoomRosterPosition(input.message, snapshot);
    return resolveRoomObservationDenial(roomRef, snapshot, input.nowMs) ??
        resolveRoomAuthorityDenial(input, authority, senderRoster) ??
        resolveRoomFloorDenial(input, snapshot, senderRoster) ??
        toAuthorizedRoomAdmission(input, authority, snapshot);
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
    const refusal = toRtcRoomRefusal(admission);
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
    authority: RtcRoomSessionObservation,
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
        resolveRtcRoomEdgeDenial(input, authority.roomRef)
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
        return { kind: 'pending', reason: 'Awaiting the required room snapshot version' };
    }
    if (senderRoster === 'behind') {
        return { kind: 'pending', reason: 'Awaiting the required room roster version' };
    }
    return undefined;
}

function toAuthorizedRoomAdmission(
    input: RtcRoomSnapshotAdmissionInput,
    authority: RtcRoomSessionObservation,
    snapshot: GroupSnapshot
): RtcRoomSnapshotAdmission {
    const authorizedSessions = snapshot.activeSessions.filter((session) =>
        resolveRtcRoomPeerDenial(authority, session.sessionId) === undefined
    );
    const authorizedPeerIds = authorizedSessions.map((session) => session.sessionId);
    const memberPeerIdSet = new Set(authorizedPeerIds);
    const forwardingPeerIds = isRoomLayoutOverlay(input.overlay, authority.roomRef)
        ? input.overlay.nextHopSessionIds.filter((peerId) => memberPeerIdSet.has(peerId))
        : [];
    return {
        kind: 'authorized',
        memberPeerIds: authorizedPeerIds,
        memberSessions: authorizedSessions,
        forwardingPeerIds,
        snapshotVersion: snapshot.group.snapshotVersion,
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

function resolveRoomObservationDenial(
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

function resolveRtcRoomEdgeDenial(
    input: RtcRoomSnapshotAdmissionInput,
    roomRef: GroupRef
): RtcRoomAuthorityDenial | undefined {
    const nextHopPeerIds = input.message.forwarding?.nextHopPeerIds;
    if (
        input.fromPeerId !== undefined && nextHopPeerIds?.length &&
        (nextHopPeerIds.length !== 1 || nextHopPeerIds[0] !== input.selfPeerId)
    ) {
        return {
            kind: 'unauthorized',
            cause: 'authority-rejected',
            reason: 'RTC transport copy targets another immediate recipient'
        };
    }
    const edgePeerId = input.recipientPeerId ??
        (input.fromPeerId !== input.message.id.senderId ? input.fromPeerId : undefined);
    const overlay = input.overlay;
    if (overlay && (overlay.state === 'removed' || !isSameGroupRef(overlay.groupRef, roomRef))) {
        return {
            kind: 'unauthorized',
            cause: 'authority-rejected',
            reason: 'RTC room topology is removed or belongs to another scope'
        };
    }
    if (edgePeerId === undefined) {
        return undefined;
    }
    if (!overlay || overlay.provenance !== 'server') {
        return { kind: 'pending', reason: 'Awaiting server room relay authority' };
    }
    // Removed/foreign overlays were rejected above; this is the current server layout's edge absence alone.
    if (!overlay.nextHopSessionIds.includes(edgePeerId)) {
        return {
            kind: 'unauthorized',
            cause: 'edge-unavailable',
            reason: 'RTC relay edge is not permitted by current server room topology'
        };
    }
    return undefined;
}
