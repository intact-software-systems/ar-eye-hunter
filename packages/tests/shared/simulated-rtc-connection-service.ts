import { onTestFinished } from 'vitest';

import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    NativeRtcRuntime,
    SimulatedNativeRtcPeerConnection
} from './native-rtc-connection-fixture.ts';

let nativeRuntime: NativeRtcRuntime | undefined;

function installSimulationNativeRuntime(): NativeRtcRuntime {
    if (nativeRuntime) {
        return nativeRuntime;
    }
    const runtime = installNativeRtcRuntime();
    nativeRuntime = runtime;
    onTestFinished(() => {
        runtime.dispose();
        nativeRuntime = undefined;
    });
    return runtime;
}

export interface SimulatedRtcConnections {
    readonly service: WebRtcConnectionService;
    markReconnectable(peerId: string): boolean;
    /** The simulated native connection behind a started setup; `setConnected()` establishes it. */
    nativePeer(peerId: string): SimulatedNativeRtcPeerConnection;
}

/**
 * Real peer ownership and dial results over the native connection fixture,
 * with simulated lane readiness. A dial starts a setup that stays in flight
 * until the test establishes its native connection, which is what lets pacing
 * tests observe the bound.
 */
export function createSimulatedRtcConnections(
    sessionId: string,
    connect: (peerId: string) => boolean = () => true
): SimulatedRtcConnections {
    const runtime = installSimulationNativeRuntime();
    const connectedPeerIds = new Set<string>();
    const fixture = createNativeRtcConnectionFixture({
        sessionId,
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc'
    }, runtime);
    const { service } = fixture;
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
    // Group scenarios control lane readiness independently of the complete native
    // peer fixture; like the real predicate, only a live peer can report its lanes.
    service.peerIdsWithNoReconnectableLanes = () => service.activePeerIds().filter((peerId) => connectedPeerIds.has(peerId));
    return {
        service,
        markReconnectable: (peerId) => connectedPeerIds.delete(peerId),
        nativePeer: fixture.nativePeer
    };
}
