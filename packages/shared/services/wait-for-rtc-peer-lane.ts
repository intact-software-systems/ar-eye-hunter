import type { PeerId } from '../api/api-config.ts';
import { CommandCancelledError, CommandTimedOutError } from '../cache/Command.ts';
import { toError } from '../resilience/to-error.ts';
import { QRtcDataChannel, type RtcDataChannelHealth } from '../webrtc/qrtc-data-channel.ts';
import type { QRtcPeerDto, WebRtcConnectionService } from './web-rtc-connection-service.ts';

interface PeerLaneIdentity {
    readonly peerId: PeerId;
    readonly laneId: string;
}

export interface PeerLaneWaitInput extends PeerLaneIdentity {
    readonly existingPeer: QRtcPeerDto | undefined;
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
    peer: QRtcPeerDto | undefined
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

function isOpenRtcChannelHealth(
    health: RtcDataChannelHealth
): boolean {
    return health.readyState === 'open' || health.state === 'Open';
}

function isClosedRtcChannelHealth(
    health: RtcDataChannelHealth
): boolean {
    return health.readyState === 'closing' ||
        health.readyState === 'closed' ||
        health.state === 'Closed' ||
        health.state === 'Failed';
}

async function waitForRtcChannelOpenOrAbort(
    channel: QRtcDataChannel,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined
): Promise<boolean> {
    const waitUntilOpen = timeoutMs === undefined
        ? channel.waitUntilOpen()
        : channel.waitUntilOpen(timeoutMs);

    if (!signal) {
        return await waitUntilOpen;
    }

    if (signal.aborted) {
        throw toError(signal.reason);
    }

    return await new Promise<boolean>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(toError(signal.reason));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        waitUntilOpen
            .then((opened) => {
                signal.removeEventListener('abort', onAbort);
                resolve(opened);
            })
            .catch((caught) => {
                const error = toError(caught);
                signal.removeEventListener('abort', onAbort);
                reject(error);
            });
    });
}
