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
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createVolatileALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type {
    ALInboundMessageRuntime,
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { ALInboundControlSubject } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import type { ALOutboundPendingAckRef } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import type { ALStoredOutboundMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage, type ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import * as shared from '@shared/mod.ts';
import type { RtcGrantedTopicReader } from '@shared/multicast/publication/rtc-granted-topic-reader.ts';
import { RtcPublicationProofVerifier } from '@shared/multicast/publication/rtc-publication-proof-verifier.ts';
import type { RtcTopicSubscriptionReader } from '@shared/multicast/publication/rtc-topic-subscription-reader.ts';
import { readRtcGroupSnapshotByRef, readRtcOutboundObservation } from '@shared/multicast/read-rtc-outbound-observation.ts';
import { computeRtcRoomSnapshotAdmission, type RtcRoomSnapshotAdmission } from '@shared/multicast/room-authority/rtc-room-snapshot-admission.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    findAcceptedOverlayById,
    readableLayoutTransitionCache,
    readablePlannedOverlayCache,
    reconcileAcceptedOverlayIdentity,
    setCurrentAcceptedServerOverlayById,
    setCurrentPlannedServerOverlayById
} from '@shared/repository/overlays-repository.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/rate-limiter.ts';
import { toPublicationVerificationCrypto, type PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import {
    createPassThroughTransportFaultPort,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcConnectionFixture
} from '../native-rtc-connection-fixture.ts';
import { ROOM_PUBLICATION_CRYPTO } from '../signature/publication-crypto-fixtures.ts';
import { waitForOwnedQueueWork } from '../wait-for-owned-queue-work.ts';
import { NO_RTC_GRANTED_TOPICS } from './rtc-granted-topic-reader-fixtures.ts';
import { createOriginOverlay, SERVED_REPLACED_LAYOUT_OVERLAP_MS, writeAcceptedServerOverlay } from './rtc-origin-overlay-fixture.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from './rtc-topic-subscription-reader-fixtures.ts';

export interface RtcRelayOverlayFixtureInput {
    readonly selfPeerId: string;
    readonly snapshot: GroupSnapshot;
    /** The overlay neighbours of the relay: its parent and its children, each with an open channel. */
    readonly neighbourPeerIds: readonly string[];
    /**
     * The layout the session holds accepted from the start, with no layout replaced; absent, every neighbour as a
     * next hop. A test's "previous" layout belongs here: an accept of it would record the starting layout as replaced.
     */
    readonly initialOverlay?: OverlayInfo;
    /** The session's memory pair a volatile message is admitted to; absent, every admission uses one in-memory pair. */
    readonly inboundVolatileStores?: ALVolatileInboundRuntimeStores;
    /** The provider the composition hands the manager; absent, the capabilities of the carrier alone. */
    readonly qosProvider?: ALQosInputProvider;
    /** The keys the overlay is cached under; absent, the bare room id. The browser sender reads the scoped key. */
    readonly overlayIds?: readonly string[];
    /** The server-served overlap the session was connected with; absent, the served default of 15 s. */
    readonly replacedLayoutOverlapMs?: number;
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
    /** Replaces the layout this relay holds planned (the server's published plan), and records no transition. */
    acceptPlannedOverlay(overlay: OverlayInfo): void;
    /**
     * Promotes `overlay` as the browser does when a group snapshot names it accepted: the planned layout is held, the
     * mismatched accepted layout is removed and the planned one promoted (`reconcileAcceptedOverlayIdentity`).
     */
    acceptSnapshotPromotion(snapshot: GroupSnapshot, overlay: OverlayInfo): void;
    /**
     * Accepts a group snapshot that names a new accepted layout this session does not hold planned, as when the snapshot
     * reaches it before the layout's publication: the mismatched accepted layout is removed and the slot stays empty
     * until `acceptOverlay` delivers the layout.
     */
    acceptSnapshotBeforeLayout(snapshot: GroupSnapshot): void;
    /** Forwards `message`, received from `fromPeerId`, as the receive pipeline's relay row does, and waits for the work it queued. */
    forward(message: ALMessage, fromPeerId: string): Promise<void>;
    /** Re-sends an admitted message's copy to the child hops `copy` names, as the relay's inbound retry does. */
    forwardRetriedCopy(copy: ALInboundMessageRuntime.RetriedCopy): Promise<void>;
    /** Every inbound diagnostic event the relay's receive pipeline emitted, in order. */
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
    /** Every diagnostic event the relay's own outbound runtime, which carries its forwards, emitted, in order. */
    readonly outboundDiagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];
    /** The relay's outbound row for a message it forwarded; absent when none is kept. */
    readOutboundMessage(msgId: string): Promise<ALStoredOutboundMessage | undefined>;
    /** The relay's outbound receipt row for a message it forwarded; absent when none is kept. */
    readOutboundReceipt(receipt: ALOutboundPendingAckRef): Promise<ALOutboundPendingAckSnapshot | undefined>;
    /** The relay row a control from `subject.fromPeerId` about `subject.msgId` would read; absent when none is kept. */
    readPendingAck(subject: ALInboundControlSubject): Promise<ALPendingAckSnapshot | undefined>;
    /**
     * The room admission's verdict now for a copy of `message` from `fromPeerId`, over this session's room, accepted
     * layout and recorded transition: the cause a refusal's diagnostic does not carry.
     */
    readRoomAdmission(message: ALMessage, fromPeerId: string): RtcRoomSnapshotAdmission;
}

/** A relay session's inbound memory pair together with the admission map it writes, which a test reads back. */
export interface ObservedVolatileInboundPair {
    readonly state: ALAdmissionMemoryState;
    readonly stores: ALVolatileInboundRuntimeStores;
}

interface RtcRelayOverlayResources {
    readonly groups: LatestRepository<string, GroupSnapshot>;
    readonly overlays: LatestRepository<string, OverlayInfo>;
    readonly overlayRepositories: RepositoryManager;
    readonly overlayIds: readonly string[];
    readonly outboundResources: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>;
    readonly outboundDiagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];
    readonly multicast: shared.WebRtcOverlayMulticastManager;
    readonly selfPeerId: string;
    readonly replacedLayoutOverlapMs: number;
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
    readonly outboundDiagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];

    constructor(dependencies: RtcRelayOverlaySession.Dependencies, neighbourPeerIds: readonly string[]) {
        this.dependencies = dependencies;
        this.diagnostics = dependencies.diagnostics;
        this.outboundDiagnostics = dependencies.outboundDiagnostics;
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
            writeAcceptedServerOverlay(overlayId, overlay, this.dependencies.overlayRepositories);
            this.dependencies.overlays.accept(overlayId, overlay);
        }
    }

    acceptPlannedOverlay(overlay: OverlayInfo): void {
        for (const overlayId of this.dependencies.overlayIds) {
            setCurrentPlannedServerOverlayById(overlayId, overlay, this.dependencies.overlayRepositories);
        }
    }

    acceptSnapshotPromotion(snapshot: GroupSnapshot, overlay: OverlayInfo): void {
        this.acceptSnapshot(snapshot);
        for (const overlayId of this.dependencies.overlayIds) {
            setCurrentPlannedServerOverlayById(overlayId, overlay, this.dependencies.overlayRepositories);
            reconcileAcceptedOverlayIdentity({
                overlayId,
                acceptedIdentity: snapshot.group.acceptedLayoutIdentity ?? undefined,
                manager: this.dependencies.overlayRepositories
            });
            this.dependencies.overlays.accept(overlayId, overlay);
        }
    }

    acceptSnapshotBeforeLayout(snapshot: GroupSnapshot): void {
        this.acceptSnapshot(snapshot);
        const { overlayIds, overlayRepositories, overlays } = this.dependencies;
        for (const overlayId of overlayIds) {
            reconcileAcceptedOverlayIdentity({
                overlayId,
                acceptedIdentity: snapshot.group.acceptedLayoutIdentity ?? undefined,
                manager: overlayRepositories
            });
            if (findAcceptedOverlayById(overlayId, overlayRepositories) === undefined) {
                overlays.delete(overlayId);
            }
        }
    }

    async forward(message: ALMessage, fromPeerId: string): Promise<void> {
        await this.ready;
        await this.dependencies.multicast.forwardIfRequired(message, fromPeerId);
        await waitForOwnedQueueWork(this.dependencies.outboundResources.workQueue);
    }

    async forwardRetriedCopy(copy: ALInboundMessageRuntime.RetriedCopy): Promise<void> {
        await this.dependencies.multicast.forwardRetriedCopy(copy);
        await waitForOwnedQueueWork(this.dependencies.outboundResources.workQueue);
    }

    async readOutboundMessage(msgId: string): Promise<ALStoredOutboundMessage | undefined> {
        return await this.dependencies.outboundResources.admissionStore.readStoredMessage(msgId);
    }

    async readOutboundReceipt(receipt: ALOutboundPendingAckRef): Promise<ALOutboundPendingAckSnapshot | undefined> {
        return await this.dependencies.outboundResources.admissionStore.readPendingAck(receipt);
    }

    async readPendingAck(subject: ALInboundControlSubject): Promise<ALPendingAckSnapshot | undefined> {
        return (await this.dependencies.inboundStores.admissionStore.readControlDecisionSurface(subject))?.pendingAck;
    }

    readRoomAdmission(message: ALMessage, fromPeerId: string): RtcRoomSnapshotAdmission {
        const { groups, overlays, overlayRepositories, selfPeerId, replacedLayoutOverlapMs } = this.dependencies;
        const observation = readRtcOutboundObservation({
            message,
            groupCache: groups,
            overlayCache: overlays,
            layoutTransitionCache: readableLayoutTransitionCache(overlayRepositories),
            plannedOverlayCache: readablePlannedOverlayCache(overlayRepositories),
            replacedLayoutOverlapMs,
            connectedPeerIds: [],
            nowMs: Date.now()
        });
        return computeRtcRoomSnapshotAdmission({
            message,
            snapshot: observation.room,
            overlay: observation.overlay,
            layoutHistory: observation.layoutHistory,
            selfPeerId,
            fromPeerId,
            recipientPeerId: undefined,
            nowMs: observation.nowMs
        });
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
    const overlayRepositories = new RepositoryManager();
    configureTestCacheRepositories(overlayRepositories, () => Date.now());
    for (const overlayId of overlayIds) {
        const initialOverlay = input.initialOverlay ?? createOriginOverlay(input.neighbourPeerIds);
        overlays.accept(overlayId, initialOverlay);
        setCurrentAcceptedServerOverlayById(overlayId, initialOverlay, overlayRepositories);
    }
    const outboundResources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
    const replacedLayoutOverlapMs = input.replacedLayoutOverlapMs ?? SERVED_REPLACED_LAYOUT_OVERLAP_MS;
    const outboundDiagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const multicast = new shared.WebRtcOverlayMulticastManager({
        quotaNow: Date.now,
        creationNow: Temporal.Now.instant,
        connectionService: connection.service,
        groupCache: groups,
        overlayCache: overlays,
        layoutTransitionCache: readableLayoutTransitionCache(overlayRepositories),
        plannedOverlayCache: readablePlannedOverlayCache(overlayRepositories),
        replacedLayoutOverlapMs,
        multicasterFactory: (overlayId) => new shared.WebRtcOverlayMulticastService(overlayId, connection.service),
        qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, input.qosProvider),
        outboundDiagnostics: (event) => outboundDiagnostics.push(event),
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
    return {
        groups,
        overlays,
        overlayRepositories,
        overlayIds,
        outboundResources,
        outboundDiagnostics,
        multicast,
        selfPeerId: input.selfPeerId,
        replacedLayoutOverlapMs
    };
}
