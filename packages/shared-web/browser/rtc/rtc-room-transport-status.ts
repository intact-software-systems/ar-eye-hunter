import type {
    RallarRoomTransportState,
    RallarRtcPeerStatus,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomLaneWaitStatus,
    RallarRtcRoomMode,
    RallarRtcStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { GroupTransportState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

interface RtcRoomTransportStateInput {
    readonly mode: RallarRtcRoomMode;
    readonly hasAcceptedLayout: boolean;
    readonly transportState?: GroupTransportState;
    readonly desiredPeerCount: number;
    readonly knownPeerCount: number;
    readonly activePeerCount: number;
    readonly readyPeerCount: number;
    readonly failedPeerCount: number;
    readonly minReadyPeers: number;
    readonly waitStatus?: RallarRtcRoomLaneWaitStatus;
}

interface RtcRoomPeerSelection {
    readonly knownPeerIds: readonly string[];
    readonly activePeerIds: readonly string[];
    readonly readyPeerIds: readonly string[];
    readonly failedPeerIds: readonly string[];
    readonly peers: readonly RallarRtcPeerStatus[];
}

export function selectRtcRoomPeers(
    status: RallarRtcStatus,
    desiredPeerIds: readonly string[],
    laneId: string
): RtcRoomPeerSelection {
    const desired = new Set(desiredPeerIds);
    const peers = status.peers.filter((peer) => desired.has(peer.peerId));
    const failedPeerIds = peers.filter((peer) => isRtcRoomPeerFailed(peer, laneId)).map((peer) => peer.peerId);
    const failed = new Set(failedPeerIds);
    return {
        knownPeerIds: status.knownPeerIds.filter((peerId) => desired.has(peerId)),
        activePeerIds: status.activePeerIds.filter((peerId) => desired.has(peerId)),
        readyPeerIds: status.readyPeerIds.filter((peerId) => desired.has(peerId) && !failed.has(peerId)),
        failedPeerIds,
        peers
    };
}

export function resolveRtcRoomTransportState(
    input: RtcRoomTransportStateInput
): RallarRoomTransportState {
    if (input.transportState === 'halted') {
        return 'halted';
    }

    if (input.mode === 'off') {
        return 'off';
    }

    if (!input.hasAcceptedLayout) {
        return 'idle';
    }

    if (input.desiredPeerCount === 0 || input.readyPeerCount === input.desiredPeerCount) {
        return 'open';
    }

    if (input.minReadyPeers > 0 && input.readyPeerCount >= input.minReadyPeers) {
        return 'partial';
    }

    if (
        input.waitStatus === 'failed' ||
        input.waitStatus === 'timeout' ||
        input.failedPeerCount >= input.desiredPeerCount
    ) {
        return input.readyPeerCount > 0 ? 'degraded' : 'failed';
    }

    if (input.failedPeerCount > 0 && input.readyPeerCount > 0) {
        return 'degraded';
    }

    if (input.knownPeerCount > 0 || input.activePeerCount > 0) {
        return 'connecting';
    }

    return 'idle';
}

export function isRtcRoomPeerFailed(peer: RallarRtcPeerStatus, laneId: string): boolean {
    const connection = peer.connection;
    if (
        connection.state === 'Failed' || connection.state === 'Closed' ||
        connection.connectionState === 'failed' || connection.connectionState === 'closed' ||
        connection.iceConnectionState === 'failed'
    ) {
        return true;
    }
    const lane = peer.lanes.find((candidate) => candidate.laneId === laneId)?.channel;
    return lane?.state === 'Failed' || lane?.state === 'Closed' || lane?.readyState === 'closed';
}

export function describeRtcRoomTransport(
    state: RallarRoomTransportState,
    readiness?: RallarRtcRoomLaneWaitResult
): string | undefined {
    if (state === 'halted') {
        return 'Room RTC is halted by authoritative group state.';
    }

    if (readiness?.status === 'empty') {
        return 'Room has no RTC peer targets.';
    }

    if (
        readiness?.status === 'timeout' ||
        readiness?.status === 'failed' ||
        readiness?.status === 'aborted' ||
        readiness?.status === 'not-connected'
    ) {
        return `Room RTC wait ended with ${readiness.status}.`;
    }

    if (state === 'idle') {
        return 'Room RTC has not started connecting yet.';
    }
    if (state === 'partial') {
        return 'Room RTC is partially ready.';
    }
    if (state === 'degraded') {
        return 'Room RTC is degraded.';
    }

    return undefined;
}
