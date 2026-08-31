import { WebRtcConnectionService } from '@shared/services/WebRtcConnectionService.ts';

export interface SimulatedRtcConnections {
    readonly service: WebRtcConnectionService;
    markReconnectable(peerId: string): boolean;
}

/** Real peer ownership and dial results with simulated native transport readiness. */
export function createSimulatedRtcConnections(
    sessionId: string,
    connect: (peerId: string) => boolean = () => true
): SimulatedRtcConnections {
    const connectedPeerIds = new Set<string>();
    const service = new WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId,
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc'
    });
    service.onRtcPeerLifecycleDo('simulated-native-transport', {
        onCreated: (peer) => {
            peer.connection.connect = () => {
                if (connect(peer.peerId)) {
                    connectedPeerIds.add(peer.peerId);
                }
            };
            for (const channel of peer.channels.values()) {
                channel.connect = () => undefined;
            }
        },
        onDeleted: (peer) => {
            connectedPeerIds.delete(peer.peerId);
        }
    });
    // This query otherwise reads native RTCPeerConnection.connectionState, absent in the simulation.
    service.peerIdsWithNoReconnectableLanes = () => [...connectedPeerIds];
    return {
        service,
        markReconnectable: (peerId) => connectedPeerIds.delete(peerId)
    };
}
