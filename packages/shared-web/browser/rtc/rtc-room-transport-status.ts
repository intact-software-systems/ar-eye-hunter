import type {
    RallarRoomTransportState,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomLaneWaitStatus,
    RallarRtcRoomMode
} from '@shared-web/browser/rallar-rtc-facade.ts';

interface RtcRoomTransportStateInput {
    readonly mode: RallarRtcRoomMode;
    readonly desiredPeerCount: number;
    readonly knownPeerCount: number;
    readonly activePeerCount: number;
    readonly readyPeerCount: number;
    readonly failedPeerCount: number;
    readonly minReadyPeers: number;
    readonly waitStatus?: RallarRtcRoomLaneWaitStatus;
}

export function resolveRtcRoomTransportState(
    input: RtcRoomTransportStateInput
): RallarRoomTransportState {
    if (input.mode === 'off') {
        return 'off';
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

export function describeRtcRoomTransport(
    state: RallarRoomTransportState,
    readiness?: RallarRtcRoomLaneWaitResult
): string | undefined {
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
