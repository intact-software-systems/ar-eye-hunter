import { vi } from 'vitest';

import { type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage, type ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createDefaultInMemoryALInboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { WebRtcConnectionService, type QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';
import {
    createDefaultWebRtcRxStreamerService,
    WebRtcRxStreamerService
} from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import type { OnQRtcMessageCallback } from '@shared/webrtc/qrtc-client-callbacks.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { waitForOwnedQueueWork } from './wait-for-owned-queue-work.ts';

export const room: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

interface RtcMessageCallbackRegistry {
    receive(message: ALMessage): Promise<void>;
}

export class RtcEndpointFixture {
    readonly groups = new LatestRepository<string, GroupSnapshot>();
    readonly overlays = new LatestRepository<string, OverlayInfo>();
    readonly outbound = createDefaultInMemoryALOutboundRuntimeStores({
        decodePrepared: decodeALOutboundTransportMessage
    });
    readonly inbound = createDefaultInMemoryALInboundRuntimeStores();
    readonly delivered: ALMessage[] = [];
    readonly sent: ALMessage[] = [];
    readonly peer: QRtcPeerDto;
    readonly multicast: WebRtcOverlayMulticastManager;
    readonly streamer: WebRtcRxStreamerService;
    private readonly messageCallbacks = new Map<string, RtcMessageCallbackRegistry>();
    readonly peers = new Map<string, QRtcPeerDto>();
    readonly received: ALMessage[] = [];
    private readonly pendingDeliveries: Promise<void>[] = [];

    readonly sessionId: string;

    constructor(sessionId: string, peerIds: string | readonly string[]) {
        this.sessionId = sessionId;
        const signaler = { send: async () => undefined, connect: async () => undefined };
        const iceCandidates = { iceServers: [], expiresAtEpochMs: 60_000 };
        const service = new WebRtcConnectionService(signaler, {
            sessionId,
            token: 'fixture-token',
            iceCandidates,
            dataChannelName: 'test',
            faultPort: createPassThroughTransportFaultPort(),
            rtcSignalingTopicId: 'rtc'
        });
        for (const peerId of typeof peerIds === 'string' ? [peerIds] : peerIds) {
            const peer = createPeer(sessionId, peerId);
            this.peers.set(peerId, peer);
            const health = peer.channel.readHealth();
            vi.spyOn(peer.channel, 'readHealth').mockReturnValue({ ...health, readyState: 'open' });
        }
        this.peer = [...this.peers.values()][0];
        vi.spyOn(service, 'readPeer').mockImplementation((id) => this.peers.get(id));
        vi.spyOn(service, 'readyPeerIdsForLane').mockImplementation(() => [...this.peers.keys()]);
        this.multicast = new WebRtcOverlayMulticastManager({
            connectionService: service,
            groupCache: this.groups,
            overlayCache: this.overlays,
            multicasterFactory: (id) => new WebRtcOverlayMulticastService(id, service),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage, stores: this.outbound }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        this.streamer = createDefaultWebRtcRxStreamerService({
            multicast: this.multicast,
            sessionId,
            inboundStores: this.inbound,
            nowEpochMs: Date.now,
            heartbeat: { maxMissedPings: 5, pingFrequencyMsecs: 5000 }
        });
        this.streamer.setRttReportingPeerIds([]);
        this.streamer.onAllInboxMessagesDo({
            onMessage: async (message) => {
                this.delivered.push(message);
            }
        });
        for (const peer of this.peers.values()) {
            this.messageCallbacks.set(peer.peerId, createRtcMessageCallbackRegistry(peer.channel));
            this.streamer.addPeer(peer);
        }
    }

    connect(remote: RtcEndpointFixture): void {
        const peer = this.peers.get(remote.sessionId)!;
        vi.spyOn(peer.channel, 'sendJson').mockImplementation((value) => {
            const message = decodePersistedALMessageValue(value);
            this.sent.push(message);
            const delivery = remote.receiveMessage(this.sessionId, message);
            this.pendingDeliveries.push(delivery);
            // The explicit fixture drain reports failures after transport submission returns.
            void delivery.catch(() => undefined);
            return { status: 'sent', bufferedAmount: 0 };
        });
    }

    async sendAndWaitForDelivery(message: ALMessage): Promise<void> {
        this.peer.channel.sendJson(message);
        await this.waitForDeliveries();
    }

    async waitForDeliveries(): Promise<void> {
        do {
            await waitForOwnedQueueWork(this.inbound.workQueue);
            await waitForOwnedQueueWork(this.outbound.workQueue);
            await Promise.all(this.pendingDeliveries.splice(0));
        }
        while (this.pendingDeliveries.length > 0);
    }

    private async receiveMessage(senderId: string, message: ALMessage): Promise<void> {
        this.received.push(message);
        await this.messageCallbacks.get(senderId)!.receive(message);
        await waitForOwnedQueueWork(this.inbound.workQueue);
        await waitForOwnedQueueWork(this.outbound.workQueue);
    }

    observe(version: number, ref: GroupRef = room, sessionIds: readonly string[] = ['sender', 'receiver']): void {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds });
        const causalRevision = { groupRevision: version, presenceRevision: version };
        this.groups.set(toScopedOverlayId(ref), {
            ...snapshot,
            causalRevision,
            group: { ...snapshot.group, snapshotVersion: version, acceptedLayoutIdentity: { ...causalRevision, version, state: 'active' } },
            activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 }))
        });
    }

    observeOverlay(version: number): void {
        this.overlays.set(toScopedOverlayId(room), {
            overlayId: toScopedOverlayId(room),
            groupRef: room,
            provenance: 'server',
            state: 'active',
            topology: 'tree',
            name: 'Room',
            sourceGroupStateCausalRevision: { groupRevision: version, presenceRevision: version },
            nextHopSessionIds: [...this.peers.keys()],
            degreeLimit: 2,
            overlayVersion: version,
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            updatedAtEpochMs: version
        });
    }

    async nacks(message: ALMessage): Promise<readonly ALNackPayload[]> {
        return this.received.flatMap((received) => {
            const control = parseALControlMessage(received);
            return control?.type === 'nack' && control.payload.msgId === message.id.msgId ? [control.payload] : [];
        });
    }

    close(): void {
        for (const peer of this.peers.values()) {
            this.streamer.removePeer(peer);
        }
        this.streamer.dispose();
        this.multicast.dispose();
    }
}

function createRtcMessageCallbackRegistry(channel: QRtcDataChannel): RtcMessageCallbackRegistry {
    const callbacks = new Map<string, OnQRtcMessageCallback>();
    vi.spyOn(channel, 'onRtcMessageDo').mockImplementation((id, callback) => {
        callbacks.set(id, callback);
        return channel;
    });
    vi.spyOn(channel, 'removeOnRtcMessageCallbackById').mockImplementation((id) => callbacks.delete(id));
    return {
        async receive(message: ALMessage): Promise<void> {
            for (const callback of callbacks.values()) {
                await callback.onMessage(message, new MessageEvent('message', { data: message }));
            }
        }
    };
}

function createPeer(sessionId: string, peerId: string): QRtcPeerDto {
    const connection = new QRtcPeerConnection({ send: async () => undefined }, {
        sessionId,
        peerSessionId: peerId,
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        isPolite: false
    });
    const channel = new QRtcDataChannel(connection, { faultPort: createPassThroughTransportFaultPort(), peerId, dataChannelName: 'test' });
    return { peerId, connection, channel, channels: new Map([['reliable', channel]]), media: new QRtcMediaChannel(connection, { peerId }) };
}
