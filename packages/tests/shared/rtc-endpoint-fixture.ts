import { vi } from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import { type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage, type ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createDefaultInMemoryALInboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
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
import { toError } from '@shared/resilience/to-error.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
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
import { ALWorkBatchTestObserver } from './alm/work/al-work-batch-test-observer.ts';
import { DeterministicRtcOfferIds } from './webrtc/deterministic-rtc-offer-ids.ts';

export const room: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

export namespace RtcEndpointFixture {
    export interface Dependencies {
        readonly outboundSettlements?: ALDeliverySettlementSink;
        readonly inbox?: OnMessageCallback;
    }

    export interface MessageCallbacks {
        receive(message: ALMessage): Promise<void>;
    }
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
    readonly peer: WebRtcConnectionService.Peer;
    readonly multicast: WebRtcOverlayMulticastManager;
    readonly streamer: WebRtcRxStreamerService;
    private readonly messageCallbacks = new Map<string, RtcEndpointFixture.MessageCallbacks>();
    readonly peers = new Map<string, WebRtcConnectionService.Peer>();
    readonly received: ALMessage[] = [];
    private readonly pendingDeliveries: Promise<void>[] = [];
    private readonly inboundBatches = new ALWorkBatchTestObserver();
    private closing: Promise<void> | undefined;

    readonly sessionId: string;

    constructor(sessionId: string, peerIds: string | readonly string[], dependencies: RtcEndpointFixture.Dependencies = {}) {
        this.sessionId = sessionId;
        const signaler = { send: async () => undefined, connect: async () => undefined };
        const iceCandidates = { iceServers: [], expiresAtEpochMs: 60_000 };
        const service = new WebRtcConnectionService(signaler, {
            sessionId,
            token: 'fixture-token',
            iceCandidates,
            dataChannelName: 'test',

            rtcSignalingTopicId: 'rtc'
        }, { faultPort: createPassThroughTransportFaultPort(), createOfferId: new DeterministicRtcOfferIds().createOfferId, nowEpochMs: () => Date.now() });
        this.createPeers(peerIds);
        this.peer = [...this.peers.values()][0];
        vi.spyOn(service, 'readPeer').mockImplementation((id) => this.peers.get(id));
        vi.spyOn(service, 'readyPeerIdsForLane').mockImplementation(() => [...this.peers.keys()]);
        this.multicast = new WebRtcOverlayMulticastManager({
            connectionService: service,
            groupCache: this.groups,
            overlayCache: this.overlays,
            multicasterFactory: (id) => new WebRtcOverlayMulticastService(id, service),
            qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, undefined),
            outboundDiagnostics: undefined,
            outboundSettlements: dependencies.outboundSettlements,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage, stores: this.outbound }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            faultPort: createPassThroughTransportFaultPort(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        const inboundDiagnostics: ALInboundRuntimeDiagnosticsSink = Object.assign(() => {}, {
            acknowledgementCapture: { evidence: ALInboundAcknowledgementEvidence, batchObservations: this.inboundBatches.batchObservations }
        });
        this.streamer = createDefaultWebRtcRxStreamerService({
            multicast: this.multicast,
            sessionId,
            inboundStores: this.inbound,
            inboundDiagnostics,
            nowEpochMs: Date.now,
            heartbeat: { maxMissedPings: 5, pingFrequencyMsecs: 5000 }
        });
        this.streamer.setRttReportingPeerIds([]);
        this.streamer.onAllInboxMessagesDo({
            onMessage: async (message, entry) => {
                this.delivered.push(message);
                await dependencies.inbox?.onMessage(message, entry);
            }
        });
        for (const peer of this.peers.values()) {
            this.messageCallbacks.set(peer.peerId, createRtcMessageCallbackRegistry(peer.channel));
            this.streamer.addPeer(peer);
        }
    }

    private createPeers(peerIds: string | readonly string[]): void {
        for (const peerId of typeof peerIds === 'string' ? [peerIds] : peerIds) {
            const peer = createPeer(this.sessionId, peerId);
            this.peers.set(peerId, peer);
            const health = peer.channel.readHealth();
            vi.spyOn(peer.channel, 'readHealth').mockReturnValue({ ...health, readyState: 'open' });
        }
    }

    connect(remote: RtcEndpointFixture): void {
        const peer = this.peers.get(remote.sessionId)!;
        vi.spyOn(peer.channel, 'sendJson').mockImplementation((value) => {
            const message = decodePersistedALMessageValue(value);
            this.sent.push(message);
            const delivery = remote.receiveMessage(this.sessionId, message);
            this.pendingDeliveries.push(delivery);
            // Submission returns before ingress; close joins the actual receive failures.
            void delivery.catch(() => undefined);
            return { status: 'sent', bufferedAmount: 0 };
        });
    }

    async sendAndWaitForDelivery(message: ALMessage): Promise<void> {
        this.peer.channel.sendJson(message);
        await Promise.all(this.pendingDeliveries.splice(0));
    }

    private async receiveMessage(senderId: string, message: ALMessage): Promise<void> {
        this.received.push(message);
        await this.messageCallbacks.get(senderId)!.receive(message);
        await this.inboundBatches.waitForPublishedBatches();
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

    close(): Promise<void> {
        this.closing ??= this.closeOwnedResources();
        return this.closing;
    }

    private async closeOwnedResources(): Promise<void> {
        const owners = await Promise.allSettled([this.streamer.dispose(), this.multicast.dispose()]);
        const arrivals = await Promise.allSettled(this.pendingDeliveries.splice(0));
        const rejected = [...arrivals, ...owners].find((outcome) => outcome.status === 'rejected');
        let failure = rejected?.status === 'rejected' ? toError(rejected.reason) : undefined;
        for (const dispose of [() => this.groups.dispose(), () => this.overlays.dispose()]) {
            try {
                dispose();
            }
            catch (caught) {
                failure ??= toError(caught);
            }
        }
        if (failure) {
            throw failure;
        }
    }
}

function createRtcMessageCallbackRegistry(channel: QRtcDataChannel): RtcEndpointFixture.MessageCallbacks {
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

function createPeer(sessionId: string, peerId: string): WebRtcConnectionService.Peer {
    const connection = new QRtcPeerConnection({ send: async () => undefined }, {
        sessionId,
        peerSessionId: peerId,
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        isPolite: false
    }, new DeterministicRtcOfferIds());
    const channel = new QRtcDataChannel(connection, { faultPort: createPassThroughTransportFaultPort(), peerId, dataChannelName: 'test' });
    return { peerId, connection, channel, channels: new Map([['reliable', channel]]), media: new QRtcMediaChannel(connection, { peerId }) };
}
