import { vi } from 'vitest';

import { toResilienceDto } from '@shared-web/browser/resilience-config.ts';
import { type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { type ALNackPayload } from '@shared/al-contracts/al-control.ts';
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
import { WebRtcConnectionService, type QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';
import type { OnQRtcMessageCallback } from '@shared/webrtc/QRtcClientCallbacks.ts';
import { QRtcDataChannel } from '@shared/webrtc/QRtcDataChannel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/QRtcMediaChannel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/QRtcPeerConnection.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

export const room: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

export class RtcEndpointFixture {
    readonly groups = new LatestRepository<string, GroupSnapshot>();
    readonly overlays = new LatestRepository<string, OverlayInfo>();
    readonly outbound = createInMemoryALOutboundRuntimeStores();
    readonly delivered: ALMessage[] = [];
    readonly sent: ALMessage[] = [];
    readonly peer: QRtcPeerDto;
    readonly multicast: WebRtcOverlayMulticastManager;
    readonly streamer: WebRtcRxStreamerService;
    readonly receive: OnQRtcMessageCallback;

    readonly sessionId: string;

    constructor(sessionId: string, peerId: string) {
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
        this.peer = createPeer(sessionId, peerId);
        vi.spyOn(service, 'readPeer').mockImplementation((id) => id === peerId ? this.peer : undefined);
        vi.spyOn(service, 'readyPeerIdsForLane').mockReturnValue([peerId]);
        const health = this.peer.channel.readHealth();
        vi.spyOn(this.peer.channel, 'readHealth').mockReturnValue({ ...health, readyState: 'open' });
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
            inboundStores: createInMemoryALInboundRuntimeStores(),
            nowEpochMs: Date.now,
            heartbeat: { maxMissedPings: 5, pingFrequencyMsecs: 5000 }
        });
        this.streamer.setRttReportingPeerIds([]);
        this.streamer.onAllInboxMessagesDo({
            onMessage: async (message) => {
                this.delivered.push(message);
            }
        });
        const registration = vi.spyOn(this.peer.channel, 'onRtcMessageDo');
        this.streamer.addPeer(this.peer);
        const receive = registration.mock.calls[0]?.[1];
        if (!receive) {
            throw new Error('RTC receiver subscription was not registered');
        }
        this.receive = receive;
    }

    connect(remote: RtcEndpointFixture): void {
        vi.spyOn(this.peer.channel, 'send').mockImplementation(async (message) => {
            this.sent.push(decodePersistedALMessageValue(message));
            await remote.receive.onMessage(message, new MessageEvent('message', { data: message }));
            await remote.multicast.dequeue(WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES, toResilienceDto());
        });
    }

    observe(version: number, ref: GroupRef = room): void {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: ['sender', 'receiver'] });
        this.groups.set(toScopedOverlayId(ref), { ...snapshot, group: { ...snapshot.group, snapshotVersion: version } });
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
            nextHopSessionIds: [this.peer.peerId],
            degreeLimit: 2,
            overlayVersion: version,
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            updatedAtEpochMs: version
        });
    }

    async nacks(message: ALMessage): Promise<readonly ALNackPayload[]> {
        if (!this.outbound.admissionStore) {
            throw new Error('Fixture admission store unavailable');
        }
        return (await this.outbound.admissionStore.readRepairMessage(message.id.msgId, () => ({ persist: false, preparedMessages: [] }))).nacks;
    }

    close(): void {
        this.streamer.removePeer(this.peer);
        this.streamer.stopAllHeartbeats();
        this.multicast.dispose();
    }
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
