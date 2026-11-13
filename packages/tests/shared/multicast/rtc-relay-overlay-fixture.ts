import { Temporal } from '@js-temporal/polyfill';
import { onTestFinished } from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    type ALPeerControlMessage,
    type ALPendingAckSnapshot
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createVolatileALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type {
    ALInboundMessageRuntime,
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { ALInboundControlSubject } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import type { ALOutboundEnqueueResult, ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage, type ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import * as shared from '@shared/mod.ts';
import type { RtcGrantedTopicReader } from '@shared/multicast/publication/rtc-granted-topic-reader.ts';
import { RtcPublicationProofVerifier } from '@shared/multicast/publication/rtc-publication-proof-verifier.ts';
import type { RtcTopicSubscriptionReader } from '@shared/multicast/publication/rtc-topic-subscription-reader.ts';
import { readRtcGroupSnapshotByRef } from '@shared/multicast/read-rtc-outbound-observation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/rate-limiter.ts';
import { toPublicationVerificationCrypto, type PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import {
    createPassThroughTransportFaultPort,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcConnectionFixture
} from '../native-rtc-connection-fixture.ts';
import { ROOM_PUBLICATION_CRYPTO } from '../signature/publication-crypto-fixtures.ts';
import { waitForOwnedQueueWork } from '../wait-for-owned-queue-work.ts';
import { NO_RTC_GRANTED_TOPICS } from './rtc-granted-topic-reader-fixtures.ts';
import { createOriginOverlay } from './rtc-origin-overlay-fixture.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from './rtc-topic-subscription-reader-fixtures.ts';

export interface RtcRelayOverlayFixtureInput {
    readonly selfPeerId: string;
    readonly snapshot: GroupSnapshot;
    /** The overlay neighbours of the relay: its parent and its children, each with an open channel. */
    readonly neighbourPeerIds: readonly string[];
    /** The session's memory pair a volatile message is admitted to; absent, every admission uses one in-memory pair. */
    readonly inboundVolatileStores?: ALVolatileInboundRuntimeStores;
    /** The provider the composition hands the manager; absent, the capabilities of the carrier alone. */
    readonly qosProvider?: ALQosInputProvider;
    /** The keys the overlay is cached under; absent, the bare room id. The browser sender reads the scoped key. */
    readonly overlayIds?: readonly string[];
    /** The transport faults the relay's overlay reads; absent, a pass-through port. */
    readonly faultPort?: TransportFaultPort;
    /** The page's granted topics; absent, none, so every frame is admitted by its room alone. */
    readonly grantedTopics?: RtcGrantedTopicReader;
    /** The relay page's own key, with which it verifies granted frames and signs its receipts; absent, the room key. */
    readonly publicationCrypto?: PublicationCrypto;
    /** The tab's held subscription tokens; absent, none is active. */
    readonly topicSubscriptions?: RtcTopicSubscriptionReader;
    /** How long the relay's room snapshot stays readable without a renewal; absent, for ever. */
    readonly groupCacheTtlMs?: number;
    /** The receive pipeline's one re-entry after an authority refresh; absent, a refusal is final. */
    readonly roomAuthorityRefresh?: shared.WebRtcRxStreamerService.RoomAuthorityRefresh;
}

/** A real RTC receive pipeline for one relay: inbound admission, the relay row, and its own forwarding. */
export interface RtcRelayOverlayFixture {
    receive(message: ALMessage, fromPeerId: string): Promise<void>;
    readSent(peerId: string): Promise<readonly ALMessage[]>;
    /** The ACKs and NACKs this session sent `peerId`, in send order. */
    readSentControls(peerId: string): Promise<readonly ALPeerControlMessage[]>;
    /** The messages this session delivered to its own inbox, in arrival order. */
    readonly delivered: readonly ALMessage[];
    /** Admits a message this session sends, as the browser sender hands it to the RTC carrier. */
    enqueue(message: ALMessage): Promise<ALOutboundEnqueueResult>;
    /** Replaces the room this relay sees, as a membership change reaches it. */
    acceptSnapshot(snapshot: GroupSnapshot): void;
    /** Replaces the layout this relay holds accepted, as the server's promotion of a new layout reaches it. */
    acceptOverlay(overlay: OverlayInfo): void;
    /** Re-sends an admitted message's copy to the child hops `copy` names, as the relay's inbound retry does. */
    forwardRetriedCopy(copy: ALInboundMessageRuntime.RetriedCopy): Promise<void>;
    /** Every inbound diagnostic event the relay's receive pipeline emitted, in order. */
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
    /** The relay row a control from `subject.fromPeerId` about `subject.msgId` would read; absent when none is kept. */
    readPendingAck(subject: ALInboundControlSubject): Promise<ALPendingAckSnapshot | undefined>;
}

/** A relay session's inbound memory pair together with the admission map it writes, which a test reads back. */
export interface ObservedVolatileInboundPair {
    readonly state: ALAdmissionMemoryState;
    readonly stores: ALVolatileInboundRuntimeStores;
}

interface RtcRelayOverlayResources {
    readonly groups: LatestRepository<string, GroupSnapshot>;
    readonly overlays: LatestRepository<string, OverlayInfo>;
    readonly overlayIds: readonly string[];
    readonly outboundResources: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>;
    readonly multicast: shared.WebRtcOverlayMulticastManager;
}

namespace RtcRelayOverlaySession {
    export interface Dependencies extends RtcRelayOverlayResources {
        readonly connection: NativeRtcConnectionFixture;
        readonly service: shared.WebRtcRxStreamerService;
        readonly inboundStores: ALInboundRuntimeStores;
        readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
    }
}

class RtcRelayOverlaySession implements RtcRelayOverlayFixture {
    private readonly dependencies: RtcRelayOverlaySession.Dependencies;
    private readonly ready: Promise<void[]>;
    readonly delivered: ALMessage[] = [];
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];

    constructor(dependencies: RtcRelayOverlaySession.Dependencies, neighbourPeerIds: readonly string[]) {
        this.dependencies = dependencies;
        this.diagnostics = dependencies.diagnostics;
        const { connection, service } = dependencies;
        service.setRttReportingPeerIds([]);
        service.onAllInboxMessagesDo({
            onMessage: async (message) => {
                this.delivered.push(message);
            }
        });
        this.ready = Promise.all(neighbourPeerIds.map((peerId) => {
            connection.service.ensurePeerConnectionStarted(peerId, true);
            const peer = connection.service.readPeer(peerId);
            if (peer === undefined) {
                throw new Error('The RTC relay neighbour was not created.');
            }
            service.addPeer(peer);
            return connection.nativePeer(peerId).channels[0].open();
        }));
    }

    async receive(message: ALMessage, fromPeerId: string): Promise<void> {
        await this.ready;
        const { connection, inboundStores, outboundResources } = this.dependencies;
        await connection.nativePeer(fromPeerId).channels[0].receive(JSON.stringify(message));
        await waitForOwnedQueueWork(inboundStores.workQueue);
        await waitForOwnedQueueWork(outboundResources.workQueue);
    }

    async readSent(peerId: string): Promise<readonly ALMessage[]> {
        const { connection, outboundResources } = this.dependencies;
        await waitForOwnedQueueWork(outboundResources.workQueue);
        return connection.nativePeer(peerId).channels[0].sent.map((frame) => decodePersistedALMessage(String(frame)));
    }

    async readSentControls(peerId: string): Promise<readonly ALPeerControlMessage[]> {
        return (await this.readSent(peerId)).flatMap((message) => {
            const control = decodeALControlMessage(message).right;
            return control === undefined || control.type === 'receipt' ? [] : [control];
        });
    }

    async enqueue(message: ALMessage): Promise<ALOutboundEnqueueResult> {
        await this.ready;
        return await this.dependencies.service.enqueueOutboxIfAbsent(message, 'hold');
    }

    acceptSnapshot(snapshot: GroupSnapshot): void {
        this.dependencies.groups.accept('room', snapshot);
    }

    acceptOverlay(overlay: OverlayInfo): void {
        for (const overlayId of this.dependencies.overlayIds) {
            this.dependencies.overlays.accept(overlayId, overlay);
        }
    }

    async forwardRetriedCopy(copy: ALInboundMessageRuntime.RetriedCopy): Promise<void> {
        await this.dependencies.multicast.forwardRetriedCopy(copy);
        await waitForOwnedQueueWork(this.dependencies.outboundResources.workQueue);
    }

    async readPendingAck(subject: ALInboundControlSubject): Promise<ALPendingAckSnapshot | undefined> {
        return (await this.dependencies.inboundStores.admissionStore.readControlDecisionSurface(subject))?.pendingAck;
    }
}

export function createRtcRelayOverlayFixture(input: RtcRelayOverlayFixtureInput): RtcRelayOverlayFixture {
    const nativeRuntime = installNativeRtcRuntime();
    onTestFinished(() => nativeRuntime.dispose());
    const connection = createNativeRtcConnectionFixture(
        {
            sessionId: input.selfPeerId,
            token: 'test-token',
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 600_000 },
            dataChannelName: 'test',
            rtcSignalingTopicId: 'rtc-signaling'
        },
        nativeRuntime,
        createPassThroughTransportFaultPort()
    );
    onTestFinished(() => connection.dispose());
    const publicationCrypto = input.publicationCrypto ?? ROOM_PUBLICATION_CRYPTO;
    const resources = createDefaultRelayOverlayResources(input, connection, publicationCrypto);
    const inboundStores = shared.createDefaultInMemoryALInboundRuntimeStores();
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const service = shared.createDefaultWebRtcRxStreamerService({
        multicast: resources.multicast,
        publicationCrypto,
        sessionId: input.selfPeerId,
        inboundStores,
        inboundVolatileStores: input.inboundVolatileStores,
        roomAuthorityRefresh: input.roomAuthorityRefresh,
        inboundDiagnostics: (event) => diagnostics.push(event)
    });
    onTestFinished(() => service.dispose());
    return new RtcRelayOverlaySession(
        { ...resources, connection, service, inboundStores, diagnostics },
        input.neighbourPeerIds
    );
}

/** The relay session's memory pair under `namespace`, whose admission map the test reads back. */
export function createObservedVolatileInboundPair(namespace: string): ObservedVolatileInboundPair {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    return {
        state,
        stores: {
            admissionStore: createVolatileALInboundAdmissionStore({
                nowMs: Date.now,
                namespace,
                backend,
                orderingTrackTtlMs: 5 * 60_000,
                supersedenceTrackTtlMs: 5 * 60_000,
                retention: normalizeALRuntimeStoreRetention(),
                maxOrderingTracks: undefined,
                maxDeliveredMarkers: undefined
            }),
            workQueue: backend.workQueue,
            evictExpired: () => backend.evictExpired(),
            budget: undefined
        }
    };
}

function createDefaultRelayOverlayResources(
    input: RtcRelayOverlayFixtureInput,
    connection: NativeRtcConnectionFixture,
    publicationCrypto: PublicationCrypto
): RtcRelayOverlayResources {
    const groups = new LatestRepository<string, GroupSnapshot>({ ttlMs: input.groupCacheTtlMs });
    onTestFinished(() => groups.dispose());
    groups.accept('room', input.snapshot);
    const overlays = new LatestRepository<string, OverlayInfo>();
    onTestFinished(() => overlays.dispose());
    const overlayIds = input.overlayIds ?? ['room'];
    for (const overlayId of overlayIds) {
        overlays.accept(overlayId, createOriginOverlay(input.neighbourPeerIds));
    }
    const outboundResources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
    const multicast = new shared.WebRtcOverlayMulticastManager({
        quotaNow: Date.now,
        creationNow: Temporal.Now.instant,
        connectionService: connection.service,
        groupCache: groups,
        overlayCache: overlays,
        multicasterFactory: (overlayId) => new shared.WebRtcOverlayMulticastService(overlayId, connection.service),
        qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, input.qosProvider),
        outboundDiagnostics: undefined,
        outboundSettlements: undefined,
        outboundRuntime: outboundResources,
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        faultPort: input.faultPort ?? createPassThroughTransportFaultPort(),
        dequeueResilience: createDefaultALOutboundDequeueResilience(),
        grantedTopics: input.grantedTopics ?? NO_RTC_GRANTED_TOPICS,
        publicationCrypto,
        publicationVerifier: new RtcPublicationProofVerifier({
            crypto: toPublicationVerificationCrypto(publicationCrypto.kind === 'available' ? publicationCrypto.subtle : undefined),
            findGroupSnapshot: (groupRef) => readRtcGroupSnapshotByRef(groups, groupRef),
            nowEpochMs: Date.now
        }),
        topicSubscriptions: input.topicSubscriptions ?? NO_RTC_TOPIC_SUBSCRIPTIONS,
        selfPrincipalId: input.selfPeerId
    });
    onTestFinished(() => multicast.dispose());
    return { groups, overlays, overlayIds, outboundResources, multicast };
}
