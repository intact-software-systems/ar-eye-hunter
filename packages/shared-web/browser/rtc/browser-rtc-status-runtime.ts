import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRtcLaneStatus,
    RallarRtcPeerConnectionStatus,
    RallarRtcPeerStatus,
    RallarRtcStatus,
    RallarRtcStatusOptions
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';

interface BrowserRtcPeerStatusInput {
    readonly peerId: string;
    readonly peer: QRtcPeerDto | undefined;
    readonly activePeerIds: ReadonlySet<string>;
    readonly peerIdsWithNoReconnectableLanes: ReadonlySet<string>;
    readonly readyPeerIds: ReadonlySet<string>;
}

export namespace BrowserRtcStatusRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readSession(): AuthSession | undefined;
    }
}

/** Owns browser RTC status and peer/lane views. */
export class BrowserRtcStatusRuntime {
    private readonly input: BrowserRtcStatusRuntime.Input;

    public constructor(input: BrowserRtcStatusRuntime.Input) {
        this.input = input;
    }

    public read(options: RallarRtcStatusOptions = {}): RallarRtcStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const context = this.input.readMiddleware();
        if (!context) {
            return {
                sessionId: this.input.readSession()?.sessionId,
                laneId,
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: []
            };
        }

        const service = context.middleware.webRtcConnectionService;
        const knownPeerIds = service.knownPeerIds();
        const activePeerIds = service.activePeerIds();
        const peerIdsWithNoReconnectableLanes = service.peerIdsWithNoReconnectableLanes();
        const readyPeerIds = service.readyPeerIdsForLane(laneId);
        const activePeerIdSet = new Set(activePeerIds);
        const peerIdsWithNoReconnectableLanesSet = new Set(
            peerIdsWithNoReconnectableLanes
        );
        const readyPeerIdSet = new Set(readyPeerIds);

        return {
            sessionId: context.session.sessionId,
            laneId,
            knownPeerIds,
            activePeerIds,
            peerIdsWithNoReconnectableLanes,
            readyPeerIds,
            peers: knownPeerIds.map((peerId) =>
                toRtcPeerStatus({
                    peerId,
                    peer: service.readPeer(peerId),
                    activePeerIds: activePeerIdSet,
                    peerIdsWithNoReconnectableLanes: peerIdsWithNoReconnectableLanesSet,
                    readyPeerIds: readyPeerIdSet
                })
            )
        };
    }

    public peer(
        peerId: string,
        options?: RallarRtcStatusOptions
    ): RallarRtcPeerStatus | undefined {
        return this.read(options).peers.find((peer) => peer.peerId === peerId);
    }

    public knownPeerIds(): readonly string[] {
        return this.input.readMiddleware()?.middleware.webRtcConnectionService
            .knownPeerIds() ?? [];
    }

    public activePeerIds(): readonly string[] {
        return this.input.readMiddleware()?.middleware.webRtcConnectionService
            .activePeerIds() ?? [];
    }

    public peerIdsWithNoReconnectableLanes(): readonly string[] {
        return this.input.readMiddleware()?.middleware.webRtcConnectionService
            .peerIdsWithNoReconnectableLanes() ?? [];
    }

    public readyPeerIds(laneId?: string): readonly string[] {
        return this.input.readMiddleware()?.middleware.webRtcConnectionService
            .readyPeerIdsForLane(laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID) ?? [];
    }
}

function toRtcPeerStatus(input: BrowserRtcPeerStatusInput): RallarRtcPeerStatus {
    const lanes = input.peer
        ? Array.from(input.peer.channels.entries()).map(([laneId, channel]) =>
            toRtcLaneStatus(input.peerId, laneId, channel.readHealth())
        )
        : [];

    return {
        peerId: input.peerId,
        connection: toRtcConnectionStatus(input.peer),
        lanes,
        isActive: input.activePeerIds.has(input.peerId),
        hasNoReconnectableLanes: input.peerIdsWithNoReconnectableLanes.has(input.peerId),
        isRoutable: input.readyPeerIds.has(input.peerId),
        readyLaneIds: lanes.filter((lane) => lane.isOpen).map((lane) => lane.laneId)
    };
}

function toRtcConnectionStatus(
    peer: QRtcPeerDto | undefined
): RallarRtcPeerConnectionStatus {
    const status = peer?.connection.status;
    const peerConnection = status?.pc;

    return {
        state: status?.state ? String(status.state) : undefined,
        connectionState: peerConnection?.connectionState,
        iceConnectionState: peerConnection?.iceConnectionState,
        iceGatheringState: peerConnection?.iceGatheringState,
        signalingState: peerConnection?.signalingState,
        hasLocalDescription: peerConnection?.localDescription !== null &&
            peerConnection?.localDescription !== undefined,
        hasRemoteDescription: peerConnection?.remoteDescription !== null &&
            peerConnection?.remoteDescription !== undefined,
        canTrickleIceCandidates: peerConnection?.canTrickleIceCandidates,
        reconnectAttempts: status?.reconnectAttempts ?? 0,
        reconnecting: status?.reconnectTimer !== undefined,
        disconnectPending: status?.disconnectTimer !== undefined,
        makingOffer: status?.makingOffer ?? false,
        ignoreOffer: status?.ignoreOffer ?? false,
        iceCandidateQueueSize: status?.iceCandidateQueue.length ?? 0,
        localStreamId: status?.localStream?.id,
        remoteStreamIds: Array.from(status?.remoteStreams.keys() ?? [])
    };
}

function toRtcLaneStatus(
    peerId: string,
    laneId: string,
    channel: RtcDataChannelHealth | undefined
): RallarRtcLaneStatus {
    return {
        peerId,
        laneId,
        channel,
        isOpen: channel?.readyState === 'open' || channel?.state === 'Open',
        isReconnectable: channel?.state === 'Idle' ||
            channel?.state === 'Closed' ||
            channel?.state === 'Failed'
    };
}
