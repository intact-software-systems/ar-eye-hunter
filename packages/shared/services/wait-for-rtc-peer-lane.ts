import type { PeerId } from '../api/api-config.ts';
import { CommandCancelledError, CommandTimedOutError } from '../cache/Command.ts';
import type { QRtcDataChannel } from '../webrtc/qrtc-data-channel.ts';
import {
    isClosedRtcChannelHealth,
    isOpenRtcChannelHealth,
    waitForRtcChannelOpenOrAbort
} from '../webrtc/rtc-data-channel-open-state.ts';
import type { WebRtcConnectionService } from './web-rtc-connection-service.ts';

interface PeerLaneIdentity {
    readonly peerId: PeerId;
    readonly laneId: string;
}

export interface PeerLaneWaitInput extends PeerLaneIdentity {
    readonly existingPeer: WebRtcConnectionService.Peer | undefined;
    readonly connected: WebRtcConnectionService.PeerConnectionResult;
    readonly timeoutMs: number | undefined;
    readonly signal: AbortSignal | undefined;
}

class WebRtcPeerLaneOpenFailure extends Error {
    readonly status: Exclude<WebRtcConnectionService.PeerLaneOpenStatus, 'open'>;
    readonly lane: PeerLaneIdentity;

    constructor(
        status: Exclude<WebRtcConnectionService.PeerLaneOpenStatus, 'open'>,
        lane: PeerLaneIdentity,
        options?: ErrorOptions
    ) {
        super(`RTC lane ${lane.laneId} for peer ${lane.peerId}: ${status}`, options);
        this.status = status;
        this.lane = lane;
        this.name = 'WebRtcPeerLaneOpenFailure';
    }
}

export async function waitForRtcPeerLane(input: PeerLaneWaitInput): Promise<QRtcDataChannel> {
    if (input.connected.left) {
        throw toPeerLaneOpenFailureFromConnectLeft(input.connected.left, input.laneId);
    }
    const peer = input.connected.right?.peer ?? input.existingPeer;
    if (!peer) {
        throw new WebRtcPeerLaneOpenFailure('no-peer', input);
    }
    const channel = peer.channels.get(input.laneId);
    if (!channel) {
        throw new WebRtcPeerLaneOpenFailure('no-lane', input);
    }
    const initialHealth = channel.readHealth();
    if (isOpenRtcChannelHealth(initialHealth)) {
        return channel;
    }
    if (isClosedRtcChannelHealth(initialHealth)) {
        throw new WebRtcPeerLaneOpenFailure('closed', input);
    }
    if (await waitForRtcChannelOpenOrAbort(channel, input.timeoutMs, input.signal)) {
        return channel;
    }
    throw new WebRtcPeerLaneOpenFailure(
        isClosedRtcChannelHealth(channel.readHealth()) ? 'closed' : 'timeout',
        input
    );
}

function toPeerLaneOpenFailureFromConnectLeft(
    left: WebRtcConnectionService.PeerConnectionLeft,
    laneId: string
): WebRtcPeerLaneOpenFailure {
    const lane = { peerId: left.peerId, laneId };
    if (left.kind === 'self') {
        return new WebRtcPeerLaneOpenFailure('self', lane);
    }
    if (left.kind === 'connect-exhausted') {
        return new WebRtcPeerLaneOpenFailure('exhausted', lane, { cause: left.error });
    }
    if (left.kind === 'dial-denied') {
        return new WebRtcPeerLaneOpenFailure('connect-failed', lane);
    }
    return new WebRtcPeerLaneOpenFailure('connect-failed', lane, { cause: left.error });
}

export function toPeerLaneOpenResultFromError(
    error: Error,
    lane: PeerLaneIdentity,
    peer: WebRtcConnectionService.Peer | undefined
): WebRtcConnectionService.PeerLaneOpenResult {
    const status = error instanceof WebRtcPeerLaneOpenFailure
        ? error.status
        : error instanceof CommandTimedOutError
        ? 'timeout'
        : error instanceof CommandCancelledError
        ? 'aborted'
        : 'failed';
    return { status, ...lane, peer, error };
}
