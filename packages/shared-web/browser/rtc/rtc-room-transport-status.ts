import type {
    RallarRoomTransportState,
    RallarRtcPeerStatus,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomLaneWaitStatus,
    RallarRtcRoomMode,
    RallarRtcStatus,
    RallarRtcWaitForOpenResult
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarReadinessEvaluation } from '@shared-web/browser/readiness.ts';
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

interface RtcRoomLaneWaitStatusInput {
    readonly evaluation: RallarReadinessEvaluation;
    readonly ready: readonly RallarRtcWaitForOpenResult[];
    readonly notReady: readonly RallarRtcWaitForOpenResult[];
    readonly preferUnsatisfiedTerminalStatus: boolean;
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

export function resolveRtcRoomLaneWaitStatus(
    input: RtcRoomLaneWaitStatusInput
): RallarRtcRoomLaneWaitStatus {
    const waitStatus = toRtcRoomLaneWaitStatus(input.ready, input.notReady);
    if (input.evaluation.status === 'over-capacity') {
        return 'over-capacity';
    }
    if (input.evaluation.status === 'empty' && input.evaluation.expectedCount === 0) {
        return 'empty';
    }
    if (input.evaluation.status === 'ready') {
        return waitStatus === 'open'
            ? 'open'
            : input.ready.length > 0
            ? 'partial'
            : 'empty';
    }
    if (!input.preferUnsatisfiedTerminalStatus) {
        return waitStatus;
    }
    if (input.notReady.some((peer) => peer.status === 'failed')) {
        return 'failed';
    }
    if (input.notReady.some((peer) => peer.status === 'aborted')) {
        return 'aborted';
    }
    if (input.notReady.some((peer) => peer.status === 'timeout')) {
        return 'timeout';
    }
    if (input.notReady.some((peer) => peer.status === 'not-connected')) {
        return 'not-connected';
    }
    return waitStatus;
}

function toRtcRoomLaneWaitStatus(
    ready: readonly RallarRtcWaitForOpenResult[],
    notReady: readonly RallarRtcWaitForOpenResult[]
): RallarRtcRoomLaneWaitStatus {
    if (ready.length === 0 && notReady.length === 0) {
        return 'empty';
    }
    if (notReady.length === 0) {
        return 'open';
    }
    if (ready.length > 0) {
        return 'partial';
    }
    if (notReady.every((peer) => peer.status === 'not-connected')) {
        return 'not-connected';
    }
    if (notReady.every((peer) => peer.status === 'timeout')) {
        return 'timeout';
    }
    if (notReady.every((peer) => peer.status === 'aborted')) {
        return 'aborted';
    }
    if (notReady.every((peer) => peer.status === 'failed')) {
        return 'failed';
    }
    return 'not-ready';
}
