import { isRoomScopedALMessage, readALTargetGroupRef, type ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import type { OverlayInfo } from '../api/api-config.ts';
import { isSameGroupRef } from '../api/api-type-utils.ts';
import type { GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '../api/group-types.ts';

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
        readonly memberPeerIds: readonly string[];
        readonly forwardingPeerIds: readonly string[];
    }
    | RtcRoomAuthorityDenial;

interface RtcRoomAuthorityDenial {
    readonly kind: 'pending' | 'unauthorized';
    readonly reason: string;
}

export interface RtcRoomSnapshotHandlingInput extends RtcRoomSnapshotAdmissionInput {
    readonly plan: ALMessageHandlingPlan;
}

export function computeRtcRoomSnapshotAdmission(input: RtcRoomSnapshotAdmissionInput): RtcRoomSnapshotAdmission {
    if (!isRoomScopedALMessage(input.message)) {
        return { kind: 'not-room' };
    }
    const roomRef = readALTargetGroupRef(input.message);
    if (!roomRef) {
        return { kind: 'unauthorized', reason: 'Room messages require a scoped group reference' };
    }
    const snapshot = input.snapshot;
    if (!snapshot) {
        return { kind: 'pending', reason: 'Awaiting a room authority observation' };
    }
    const roomDenial = resolveRoomObservationDenial(roomRef, snapshot, input.nowMs);
    if (roomDenial) {
        return roomDenial;
    }
    const authority = {
        roomRef,
        nowMs: input.nowMs,
        sessions: new Map(snapshot.activeSessions.map((session) => [session.sessionId, session])),
        members: new Map(snapshot.members.map((member) => [member.principalId, member]))
    };
    const requiredPeerIds = [input.message.id.senderId, input.selfPeerId, input.fromPeerId, input.recipientPeerId];
    const denials = [
        ...Array.from(
            new Set(requiredPeerIds),
            (peerId) => peerId === undefined ? undefined : resolveRoomSessionDenial(authority, peerId)
        ),
        resolveRtcRoomEdgeDenial(input, roomRef)
    ];
    const denial = denials.find((candidate) => candidate?.kind === 'unauthorized') ??
        denials.find((candidate) => candidate !== undefined);
    if (denial) {
        return denial;
    }
    const targets = input.message.targets;
    const floor = targets && targets.mode !== 'unicast' ? targets.minSnapshotVersion : undefined;
    if (floor !== undefined && snapshot.group.snapshotVersion < floor) {
        return { kind: 'pending', reason: 'Awaiting the required room snapshot version' };
    }
    const memberPeerIds = snapshot.activeSessions.filter((session) =>
        resolveRoomSessionDenial(authority, session.sessionId) === undefined
    ).map((session) => session.sessionId);
    const memberPeerIdSet = new Set(memberPeerIds);
    const forwardingPeerIds = input.overlay?.provenance === 'server' && input.overlay.state === 'active' &&
            isSameGroupRef(input.overlay.groupRef, roomRef)
        ? input.overlay.nextHopSessionIds.filter((peerId) => memberPeerIdSet.has(peerId))
        : [];
    return { kind: 'authorized', memberPeerIds, forwardingPeerIds };
}

export function planRtcRoomSnapshotAdmission(input: RtcRoomSnapshotHandlingInput): ALMessageHandlingPlan {
    return toRtcRoomSnapshotHandlingPlan(input.plan, computeRtcRoomSnapshotAdmission(input), input.fromPeerId);
}

export function toRtcRoomSnapshotHandlingPlan(
    plan: ALMessageHandlingPlan,
    admission: RtcRoomSnapshotAdmission,
    fromPeerId: string | undefined
): ALMessageHandlingPlan {
    if (
        admission.kind === 'authorized' || admission.kind === 'not-room' || plan.dropReason?.includes('expired') ||
        plan.dropReason === 'duplicate'
    ) {
        return plan;
    }
    const pending = admission.kind === 'pending';
    return {
        ...plan,
        dropReason: pending ? 'not-yet-in-sync' : 'unauthorized',
        localDelivery: { enabled: false, persist: false, deferred: false },
        forwarding: { enabled: false, persist: false, nextHopPeerIds: [] },
        ack: { enabled: false, algo: 'none', deferred: false },
        nack: {
            enabled: pending && fromPeerId !== undefined,
            toPeerId: fromPeerId,
            reason: pending ? 'not-yet-in-sync' : 'unauthorized',
            missingSeqs: []
        },
        repair: { enabled: false, algo: 'none' }
    };
}

function resolveRoomObservationDenial(
    roomRef: GroupRef,
    snapshot: GroupSnapshot,
    nowMs: number
): RtcRoomAuthorityDenial | undefined {
    if (!isSameGroupRef(snapshot.group, roomRef)) {
        return { kind: 'unauthorized', reason: 'Room authority belongs to another scope' };
    }
    if (
        snapshot.group.status !== 'active' ||
        (snapshot.group.expiresAtEpochMs !== null && snapshot.group.expiresAtEpochMs <= nowMs)
    ) {
        return { kind: 'unauthorized', reason: 'Room authority is inactive or expired' };
    }
    return undefined;
}

interface RtcRoomSessionObservation {
    readonly roomRef: GroupRef;
    readonly sessions: ReadonlyMap<string, GroupPresenceSession>;
    readonly members: ReadonlyMap<string, GroupMember>;
    readonly nowMs: number;
}

function resolveRoomSessionDenial(
    input: RtcRoomSessionObservation,
    peerId: string
): RtcRoomAuthorityDenial | undefined {
    const session = input.sessions.get(peerId);
    if (!session) {
        return { kind: 'pending', reason: 'Awaiting room session authority' };
    }
    if (
        !isSameGroupRef(session, input.roomRef) || session.status !== 'active' ||
        session.expiresAtEpochMs <= input.nowMs
    ) {
        return { kind: 'unauthorized', reason: 'Room session authority is inactive, expired, or in another scope' };
    }
    const member = input.members.get(session.principalId);
    if (!member) {
        return { kind: 'pending', reason: 'Awaiting room member authority' };
    }
    if (member.status !== 'active' || !isSameGroupRef(member, input.roomRef)) {
        return { kind: 'unauthorized', reason: 'Room member authority is inactive or in another scope' };
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
        return { kind: 'unauthorized', reason: 'RTC transport copy targets another immediate recipient' };
    }
    const edgePeerId = input.recipientPeerId ??
        (input.fromPeerId !== input.message.id.senderId ? input.fromPeerId : undefined);
    const overlay = input.overlay;
    if (overlay && (overlay.state === 'removed' || !isSameGroupRef(overlay.groupRef, roomRef))) {
        return { kind: 'unauthorized', reason: 'RTC room topology is removed or belongs to another scope' };
    }
    if (edgePeerId === undefined) {
        return undefined;
    }
    if (!overlay || overlay.provenance !== 'server') {
        return { kind: 'pending', reason: 'Awaiting server room relay authority' };
    }
    if (
        overlay.state !== 'active' || !isSameGroupRef(overlay.groupRef, roomRef) ||
        !overlay.nextHopSessionIds.includes(edgePeerId)
    ) {
        return { kind: 'unauthorized', reason: 'RTC relay edge is not permitted by current server room topology' };
    }
    return undefined;
}
