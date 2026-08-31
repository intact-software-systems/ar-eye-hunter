import { onTestFinished } from 'vitest';

import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { installNativeRtcRuntime, NativeRtcRuntime } from './native-rtc-connection-fixture.ts';

let nativeRuntime: NativeRtcRuntime | undefined;

function installSimulationNativeRuntime(): void {
    if (nativeRuntime) {
        return;
    }
    const runtime = installNativeRtcRuntime();
    nativeRuntime = runtime;
    onTestFinished(() => {
        runtime.dispose();
        nativeRuntime = undefined;
    });
}

export interface SimulatedRtcConnections {
    readonly service: WebRtcConnectionService;
    markReconnectable(peerId: string): boolean;
}

/** Real peer ownership and dial results with simulated native transport readiness. */
export function createSimulatedRtcConnections(
    sessionId: string,
    connect: (peerId: string) => boolean = () => true
): SimulatedRtcConnections {
    installSimulationNativeRuntime();
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
            for (const channel of peer.channels.values()) {
                channel.connect = () => {
                    try {
                        if (connect(peer.peerId)) {
                            connectedPeerIds.add(peer.peerId);
                        }
                    }
                    catch (error) {
                        peer.connection.reset();
                        throw error;
                    }
                };
            }
        },
        onDeleted: (peer) => {
            connectedPeerIds.delete(peer.peerId);
        }
    });
    // Group scenarios control lane readiness independently of the complete native peer fixture.
    service.peerIdsWithNoReconnectableLanes = () => [...connectedPeerIds];
    return {
        service,
        markReconnectable: (peerId) => connectedPeerIds.delete(peerId)
    };
}
