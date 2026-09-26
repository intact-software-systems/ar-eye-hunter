import { onTestFinished } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import * as shared from '@shared/mod.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import { createNativeRtcConnectionFixture, installNativeRtcRuntime } from '../native-rtc-connection-fixture.ts';
import { waitForALInboundWork } from '../wait-for-al-inbound-work.ts';
import { createOriginOverlay } from './rtc-origin-overlay-fixture.ts';

export interface RtcRelayOverlayFixtureInput {
    readonly selfPeerId: string;
    readonly snapshot: GroupSnapshot;
    /** The overlay neighbours of the relay: its parent and its children, each with an open channel. */
    readonly neighbourPeerIds: readonly string[];
}

/** A real RTC receive pipeline for one relay: inbound admission, the relay row, and its own forwarding. */
export interface RtcRelayOverlayFixture {
    receive(message: ALMessage, fromPeerId: string): Promise<void>;
    readSent(peerId: string): Promise<readonly ALMessage[]>;
}

export function createRtcRelayOverlayFixture(input: RtcRelayOverlayFixtureInput): RtcRelayOverlayFixture {
    const nativeRuntime = installNativeRtcRuntime();
    const connection = createNativeRtcConnectionFixture({
        sessionId: input.selfPeerId,
        token: 'test-token',
        faultPort: createPassThroughTransportFaultPort(),
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 600_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc-signaling'
    }, nativeRuntime);
    const groups = new LatestRepository<string, GroupSnapshot>();
    groups.accept('room', input.snapshot);
    const overlays = new LatestRepository<string, OverlayInfo>();
    overlays.accept('room', createOriginOverlay(input.neighbourPeerIds));
    const multicast = new shared.WebRtcOverlayMulticastManager({
        connectionService: connection.service,
        groupCache: groups,
        overlayCache: overlays,
        multicasterFactory: (overlayId) => new shared.WebRtcOverlayMulticastService(overlayId, connection.service),
        qosProvider: undefined,
        outboundDiagnostics: undefined,
        outboundSettlements: undefined,
        outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        dequeueResilience: createDefaultALOutboundDequeueResilience()
    });
    const service = shared.createDefaultWebRtcRxStreamerService({
        multicast,
        sessionId: input.selfPeerId,
        inboundStores: shared.createDefaultInMemoryALInboundRuntimeStores(),
        roomAuthorityRefresh: undefined
    });
    service.setRttReportingPeerIds([]);
    service.onAllInboxMessagesDo({ onMessage: async () => undefined });
    const openings = input.neighbourPeerIds.map((peerId) => {
        connection.service.ensurePeerConnectionStarted(peerId, true);
        service.addPeer(connection.service.readPeer(peerId)!);
        return connection.nativePeer(peerId).channels[0].open();
    });
    const ready = Promise.all(openings);
    onTestFinished(() => {
        service.dispose();
        multicast.dispose();
        connection.dispose();
        groups.dispose();
        overlays.dispose();
        nativeRuntime.dispose();
    });
    return {
        receive: async (message, fromPeerId) => {
            await ready;
            await connection.nativePeer(fromPeerId).channels[0].receive(JSON.stringify(message));
            await waitForALInboundWork();
        },
        readSent: async (peerId) => {
            await waitForALInboundWork();
            return connection.nativePeer(peerId).channels[0].sent.map((frame) => decodePersistedALMessage(String(frame)));
        }
    };
}
