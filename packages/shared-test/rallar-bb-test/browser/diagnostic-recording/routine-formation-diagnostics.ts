import type { BlackBoxRallarFormationRoomStatus } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarRoomFormationStatus } from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { isGroupLayoutIdentity, isSameGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { isAcceptedRoomLayoutOverlay } from '@shared/repository/is-accepted-room-layout-overlay.ts';

import {
    isClosedRecord,
    isIdentity,
    isIdentityList,
    isNonnegativeInteger,
    isNonnegativeNumber,
    isSameIdentitySet
} from './routine-diagnostic-values.ts';
import { isRoutineRtcPeer, isRoutineWsStatus } from './routine-transport-diagnostics.ts';

interface FormationRoomDiagnostic {
    readonly room: BlackBoxRallarFormationRoomStatus;
    readonly groupRevision: number;
}

/** The source still owns the full facts which its recorded projection intentionally omits. */
export function isRoutineFormationObservation(
    roomRef: GroupRef,
    status: RallarRoomFormationStatus,
    transport: RallarRoomTransportStatus
): boolean {
    if (
        !isRoutineFormationStatus(status) || !isSameGroupRef(roomRef, status.roomRef) ||
        !isClosedRecord(transport, ['roomRef', 'roomId', 'ws', 'rtc']) || !transport.roomRef ||
        !isSameGroupRef(roomRef, transport.roomRef) ||
        (transport.roomId !== undefined && transport.roomId !== roomRef.groupId) ||
        !isRoutineWsStatus(transport.ws, false)
    ) {
        return false;
    }
    const room = transport.rtc;
    if (
        !isClosedRecord(room, [
            'desired',
            'mode',
            'state',
            'acceptedLayoutIdentity',
            'desiredPeerIds',
            'knownPeerIds',
            'activePeerIds',
            'readyPeerIds',
            'failedPeerIds',
            'peers',
            'laneId',
            'lastChangedAtEpochMs',
            'reason'
        ]) ||
        room.desired !== true || !['lazy', 'warm', 'eager'].includes(room.mode) || room.reason !== undefined ||
        !isIdentity(room.laneId) || !isGroupLayoutIdentity(room.acceptedLayoutIdentity) ||
        !isSameGroupLayoutIdentity(status.accepted!.identity, room.acceptedLayoutIdentity) ||
        (room.lastChangedAtEpochMs !== undefined && !isNonnegativeNumber(room.lastChangedAtEpochMs)) ||
        !Array.isArray(room.peers) || !room.peers.every(isRoutineRtcPeer) || !isIdentityList(room.knownPeerIds)
    ) {
        return false;
    }
    return isRoutineFormationRoomDetail({
        room: {
            state: room.state,
            acceptedLayoutIdentity: room.acceptedLayoutIdentity,
            desiredPeerIds: room.desiredPeerIds,
            readyPeerIds: room.readyPeerIds,
            activePeerIds: room.activePeerIds,
            failedPeerIds: room.failedPeerIds
        },
        groupRevision: status.snapshot.causalRevision.groupRevision
    }) &&
        isSameIdentitySet(room.knownPeerIds, room.peers.map((peer) => peer.peerId)) &&
        room.knownPeerIds.every((peerId) => room.desiredPeerIds.includes(peerId)) &&
        isSameIdentitySet(room.activePeerIds, room.peers.filter((peer) => peer.isActive).map((peer) => peer.peerId)) &&
        isSameIdentitySet(
            room.readyPeerIds,
            room.peers.filter((peer) => peer.readyLaneIds.includes(room.laneId)).map((peer) => peer.peerId)
        );
}

function isRoutineFormationStatus(status: RallarRoomFormationStatus): boolean {
    if (
        !isClosedRecord(status, [
            'roomRef',
            'stage',
            'formationEpoch',
            'formationAttemptCount',
            'lastFormationOutcome',
            'transportState',
            'dialing',
            'memberPolicy',
            'accepted',
            'planned',
            'condition',
            'coverageRate',
            'snapshot'
        ]) ||
        (status.stage !== 'active' && status.stage !== 'reconfiguring') || status.transportState !== 'flowing' ||
        status.planned !== undefined || status.dialing !== 'accepted' || !isRoutineMemberPolicy(status) ||
        status.formationAttemptCount !== 0 || !isNonnegativeInteger(status.formationEpoch) ||
        (status.condition !== undefined && status.condition !== 'active' && status.condition !== 'initialising') ||
        (status.coverageRate !== undefined && (!isNonnegativeNumber(status.coverageRate) || status.coverageRate > 1))
    ) {
        return false;
    }
    if (
        status.lastFormationOutcome !== undefined &&
        (!isClosedRecord(status.lastFormationOutcome, ['outcome', 'observedRate', 'atEpochMs', 'formationEpoch']) ||
            status.lastFormationOutcome.outcome !== 'activated' ||
            !isNonnegativeNumber(status.lastFormationOutcome.observedRate) ||
            status.lastFormationOutcome.observedRate > 1 ||
            !isNonnegativeNumber(status.lastFormationOutcome.atEpochMs) ||
            !isNonnegativeNumber(status.lastFormationOutcome.formationEpoch))
    ) {
        return false;
    }
    const accepted = status.accepted;
    return accepted !== undefined && isClosedRecord(accepted, ['role', 'identity', 'overlay']) &&
        accepted.role === 'accepted' &&
        isGroupLayoutIdentity(accepted.identity) && accepted.identity.state === 'active' &&
        accepted.overlay !== null && isAcceptedRoomLayoutOverlay(accepted.overlay, status.snapshot.group) &&
        isSameGroupRef(status.roomRef, accepted.overlay.groupRef) &&
        isSameGroupRef(status.roomRef, status.snapshot.group) &&
        isGroupLayoutIdentity(status.snapshot.group.acceptedLayoutIdentity) &&
        isSameGroupLayoutIdentity(accepted.identity, status.snapshot.group.acceptedLayoutIdentity);
}

/** Admission checks only this closed encoded projection; the source certificate proves its omitted context. */
export function isRoutineFormationRoomDetail(detail: unknown): detail is FormationRoomDiagnostic {
    if (
        !isClosedRecord(detail, ['room', 'groupRevision']) || !isNonnegativeInteger(detail.groupRevision) ||
        !isClosedRecord(detail.room, [
            'state',
            'acceptedLayoutIdentity',
            'desiredPeerIds',
            'readyPeerIds',
            'activePeerIds',
            'failedPeerIds'
        ])
    ) {
        return false;
    }
    const room = detail.room;
    if (
        !isGroupLayoutIdentity(room.acceptedLayoutIdentity) || room.acceptedLayoutIdentity.state !== 'active' ||
        !isIdentityList(room.desiredPeerIds) || room.desiredPeerIds.length === 0 ||
        !isIdentityList(room.readyPeerIds) || !isIdentityList(room.activePeerIds) ||
        !Array.isArray(room.failedPeerIds) || room.failedPeerIds.length !== 0
    ) {
        return false;
    }
    return room.activePeerIds.every((peerId) => (room.desiredPeerIds as string[]).includes(peerId)) &&
        room.readyPeerIds.every((peerId) => (room.activePeerIds as string[]).includes(peerId)) &&
        (room.state === 'connecting' && !isSameIdentitySet(room.desiredPeerIds, room.readyPeerIds) ||
            room.state === 'open' && isSameIdentitySet(room.desiredPeerIds, room.readyPeerIds));
}

function isRoutineMemberPolicy(status: RallarRoomFormationStatus): boolean {
    return isClosedRecord(status.memberPolicy, ['maxConcurrentEdgeSetups', 'transports']) &&
        isNonnegativeInteger(status.memberPolicy.maxConcurrentEdgeSetups) &&
        status.memberPolicy.maxConcurrentEdgeSetups > 0 &&
        (status.memberPolicy.transports === 'rtc-and-ws' || status.memberPolicy.transports === 'rtc-preferred');
}
