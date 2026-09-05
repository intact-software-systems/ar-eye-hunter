import { vi } from 'vitest';

import { toResilienceDto } from '@shared-web/browser/resilience-config.ts';
import { type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage, type ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createDefaultInMemoryALInboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { WebRtcConnectionService, type QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';
import {
    createDefaultWebRtcRxStreamerService,
    WebRtcRxStreamerService
} from '@shared/services/web-rtc-rx-streamer-service.ts';
import type { OnQRtcMessageCallback } from '@shared/webrtc/qrtc-client-callbacks.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

export const room: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

interface RtcMessageCallbackRegistry {
    receive(message: ALMessage): Promise<void>;
}

export class RtcEndpointFixture {
    readonly groups = new LatestRepository<string, GroupSnapshot>();
    readonly overlays = new LatestRepository<string, OverlayInfo>();
    readonly outbound = createDefaultInMemoryALOutboundRuntimeStores();
    readonly delivered: ALMessage[] = [];
    readonly sent: ALMessage[] = [];
    readonly peer: QRtcPeerDto;
    readonly multicast: WebRtcOverlayMulticastManager;
    readonly streamer: WebRtcRxStreamerService;
    private readonly messageCallbacks = new Map<string, RtcMessageCallbackRegistry>();
    readonly peers = new Map<string, QRtcPeerDto>();
    readonly received: ALMessage[] = [];

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
            outbox: new InMemoryQueueBox(),
            connectionService: service,
            groupCache: this.groups,
            overlayCache: this.overlays,
            multicasterFactory: (id) => new WebRtcOverlayMulticastService(id, service),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ stores: this.outbound }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter()
        });
        this.streamer = createDefaultWebRtcRxStreamerService({
            inbox: new InMemoryQueueBox(),
            multicast: this.multicast,
            sessionId,
            inboundStores: createDefaultInMemoryALInboundRuntimeStores(),
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
        vi.spyOn(peer.channel, 'send').mockImplementation(async (message) => {
            this.sent.push(decodePersistedALMessageValue(message));
            remote.received.push(decodePersistedALMessageValue(message));
            await remote.messageCallbacks.get(this.sessionId)!.receive(decodePersistedALMessageValue(message));
            await remote.multicast.dequeue(WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES, toResilienceDto());
        });
    }

    observe(version: number, ref: GroupRef = room, sessionIds: readonly string[] = ['sender', 'receiver']): void {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds });
        this.groups.set(toScopedOverlayId(ref), {
            ...snapshot,
            group: { ...snapshot.group, snapshotVersion: version },
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
    const channel = new QRtcDataChannel(connection, { peerId, dataChannelName: 'test' });
    return { peerId, connection, channel, channels: new Map([['reliable', channel]]), media: new QRtcMediaChannel(connection, { peerId }) };
}
