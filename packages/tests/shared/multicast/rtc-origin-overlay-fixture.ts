import { Temporal } from '@js-temporal/polyfill';
import { onTestFinished, vi } from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import {
    newALMulticastMessage,
    type ALMessage,
    type ALTargets
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, type ALAckStatus, type ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeStores,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { createRallarGroupDirectorAppointment, mergeRallarGroupDirectorMetadata } from '@shared/api/group-director.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { RtcGrantedTopicReader } from '@shared/multicast/publication/rtc-granted-topic-reader.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import type { OverlayLayoutTransition } from '@shared/repository/overlay-layout-transition.ts';
import {
    didOverlayAdoptionChange,
    readableLayoutTransitionCache,
    readablePlannedOverlayCache,
    setCurrentAcceptedServerOverlayById
} from '@shared/repository/overlays-repository.ts';
import { toCircuitBreaker, type CircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter, type RateLimiter } from '@shared/resilience/rate-limiter.ts';
import type { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import {
    createPassThroughTransportFaultPort,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';
import {
    ROOM_PUBLICATION_CRYPTO,
    ROOM_PUBLICATION_KEY,
    type AvailablePublicationCrypto
} from '../signature/publication-crypto-fixtures.ts';
import { NO_RTC_GRANTED_TOPICS } from './rtc-granted-topic-reader-fixtures.ts';
import { KEYLESS_PUBLICATION_VERIFIER } from './rtc-publication-proof-verifier-fixtures.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from './rtc-topic-subscription-reader-fixtures.ts';

import { signTestALReceiptControl, toTestALAckPayload } from '../../al-control-test-payloads.ts';

export interface CapturedChannel {
    readonly channel: QRtcDataChannel;
    readonly sent: ALMessage[];
}

/** The RTC origin `a` in one room, with an open channel to every peer it may address. */
export interface RtcOriginOverlayFixture {
    readonly manager: WebRtcOverlayMulticastManager;
    readonly resources: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>;
    readonly groups: LatestRepository<string, GroupSnapshot>;
    /** The overlay cache the manager reads; a write here records no layout transition, `acceptOverlay` does. */
    readonly overlays: LatestRepository<string, OverlayInfo>;
    readonly layoutTransitions: ReadableKeyedValues<string, OverlayLayoutTransition>;
    /** Accepts a layout as the overlay repository does, which records the transition it replaces. */
    acceptOverlay(overlay: OverlayInfo): void;
    readonly channels: Readonly<Record<string, CapturedChannel>>;
    readonly ready: { peerIds: readonly string[]; };
    readonly settlements: readonly ALDeliverySettlement[];
    readonly diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];
}

export interface RtcOriginOverlayFixtureInput {
    readonly creationNow?: QueueBoxUtilities.CreationClock;
    /** Numerical epoch domain of the supplied limiter; absent, the fixture's Date clock. */
    readonly quotaNow?: () => number;
    readonly snapshot: GroupSnapshot;
    /** The overlay next hops of the origin, each with an open channel. */
    readonly nextHopPeerIds: readonly string[];
    /** The accepted layout's whole adjacency; absent, the overlay carries none, as a bootstrap overlay does. */
    readonly nextHopsBySessionId?: OverlayInfo['nextHopsBySessionId'];
    readonly circuitBreaker?: CircuitBreaker;
    /** The server-served overlap the session was connected with; absent, the served default of 15 s. */
    readonly replacedLayoutOverlapMs?: number;
    /** The same admission policy port production supplies; absent, the default RTC limiter. */
    readonly rateLimiter?: RateLimiter;
    /** The durable pair the origin admits to; absent, an in-memory pair (a counting test hands an IndexedDB one). */
    readonly stores?: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    /** The memory pair the browser composition gives the origin; absent, every admission uses one backend. */
    readonly volatileStores?: ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage>;
    /** The session's provider the composition hands the manager; absent, the carrier's capabilities alone. */
    readonly qosProvider?: ALQosInputProvider;
    /** The session's transport faults; absent, a pass-through port. */
    readonly faultPort?: TransportFaultPort;
    /** Also told every settlement the fixture records, as a browser session's delivery feed is; absent, only recorded. */
    readonly onSettlement?: (settlement: ALDeliverySettlement) => void;
    /** The page's granted topics; absent, none, so every publication is carried unsigned. */
    readonly grantedTopics?: RtcGrantedTopicReader;
    /** The page's key; absent, the key every room session of the fixture registers. */
    readonly publicationCrypto?: PublicationCrypto;
}

export interface OriginAcknowledgementInput {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly status: ALAckStatus;
    /** The key the ACK is signed with: the room key every fixture session registers, or a test's own per-session key. */
    readonly key: AvailablePublicationCrypto;
}

export const ORIGIN_ROOM: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

export const ORIGIN_PRINCIPAL_REF = {
    applicationId: ORIGIN_ROOM.applicationId,
    workspaceId: ORIGIN_ROOM.workspaceId,
    principalId: 'principal-1'
} as const;

/** The overlap the server serves by default. */
export const SERVED_REPLACED_LAYOUT_OVERLAP_MS = 15_000;
const CHANNEL_PEER_IDS = ['b', 'c', 'd', 'g', 'r'];

export function createRtcOriginOverlayFixture(input: RtcOriginOverlayFixtureInput): RtcOriginOverlayFixture {
    const ready = { peerIds: input.nextHopPeerIds };
    const channels = Object.fromEntries(CHANNEL_PEER_IDS.map((peerId) => [peerId, createOpenChannel(peerId)]));
    const connection = createConnectionService(ready, channels);
    const groups = new LatestRepository<string, GroupSnapshot>();
    groups.accept('room', input.snapshot);
    const overlays = new LatestRepository<string, OverlayInfo>();
    const initialOverlay = createOriginOverlay(input.nextHopPeerIds, input.nextHopsBySessionId);
    overlays.accept('room', initialOverlay);
    const repositories = new RepositoryManager();
    configureTestCacheRepositories(repositories, () => Date.now());
    setCurrentAcceptedServerOverlayById('room', initialOverlay, repositories);
    const layoutTransitions = readableLayoutTransitionCache(repositories);
    const resources = createDefaultALOutboundRuntimeResources({
        decodePrepared: decodeALOutboundTransportMessage,
        stores: input.stores,
        volatileStores: input.volatileStores
    });
    const settlements: ALDeliverySettlement[] = [];
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const manager = new WebRtcOverlayMulticastManager({
        creationNow: input.creationNow ?? Temporal.Now.instant,
        quotaNow: input.quotaNow ?? Date.now,
        connectionService: connection,
        groupCache: groups,
        overlayCache: overlays,
        layoutTransitionCache: layoutTransitions,
        plannedOverlayCache: readablePlannedOverlayCache(repositories),
        replacedLayoutOverlapMs: input.replacedLayoutOverlapMs ?? SERVED_REPLACED_LAYOUT_OVERLAP_MS,
        multicasterFactory: (overlayId) => new WebRtcOverlayMulticastService(overlayId, connection),
        qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, input.qosProvider),
        outboundDiagnostics: (event) => diagnostics.push(event),
        outboundSettlements: (settlement) => {
            settlements.push(settlement);
            input.onSettlement?.(settlement);
        },
        outboundRuntime: resources,
        circuitBreaker: input.circuitBreaker ?? toCircuitBreaker(),
        rateLimiter: input.rateLimiter ?? toRateLimiter(),
        faultPort: input.faultPort ?? createPassThroughTransportFaultPort(),
        dequeueResilience: createDefaultALOutboundDequeueResilience(),
        grantedTopics: input.grantedTopics ?? NO_RTC_GRANTED_TOPICS,
        publicationCrypto: input.publicationCrypto ?? ROOM_PUBLICATION_CRYPTO,
        publicationVerifier: KEYLESS_PUBLICATION_VERIFIER,
        topicSubscriptions: NO_RTC_TOPIC_SUBSCRIPTIONS,
        selfPrincipalId: 'a'
    });
    onTestFinished(() => manager.dispose());
    const acceptOverlay = (overlay: OverlayInfo): void => {
        writeAcceptedServerOverlay('room', overlay, repositories);
        overlays.accept('room', overlay);
    };
    return {
        manager,
        resources,
        groups,
        overlays,
        layoutTransitions,
        acceptOverlay,
        channels,
        ready,
        settlements,
        diagnostics
    };
}

/**
 * Writes a fixture's accepted layout to the overlay repository, failing the test when the repository drops it: the
 * fixture's own overlay cache would keep the layout while the repository's transition named another as replaced.
 */
export function writeAcceptedServerOverlay(overlayId: string, overlay: OverlayInfo, repositories: RepositoryManager): void {
    const outcome = setCurrentAcceptedServerOverlayById(overlayId, overlay, repositories);
    if (!didOverlayAdoptionChange(outcome) && outcome !== 'equal') {
        throw new Error(
            `The overlay repository dropped the accepted layout version ${overlay.overlayVersion} of ${overlayId} (${outcome}).`
        );
    }
}

export function createOriginReceiverMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: resourceId },
        { ack: 'all-logical-recipients', reliability: 'at-least-once', ttlMs: 30_000, traceId: `trace-${resourceId}` }
    );
}

export function toOriginFrozenTargets(recipientPeerIds: readonly string[], snapshotVersion: number): ALTargets {
    return { mode: 'multicast', groupRef: ORIGIN_ROOM, recipientPeerIds, snapshotVersion };
}

export function readSentTargets(captured: CapturedChannel): readonly (ALTargets | undefined)[] {
    return captured.sent.map((message) => message.targets);
}

export async function enqueueAndDrain(
    manager: WebRtcOverlayMulticastManager,
    message: ALMessage
): Promise<ALOutboundEnqueueResult> {
    const result = await manager.enqueueIfAbsent(message);
    await vi.advanceTimersByTimeAsync(0);
    return result;
}

export async function acknowledgeAtOrigin(
    manager: WebRtcOverlayMulticastManager,
    input: OriginAcknowledgementInput
): Promise<void> {
    const signed = await signTestALReceiptControl(input.key, {
        type: 'ack',
        payload: toTestALAckPayload({
            ackedMsgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            carrier: 'rtc',
            status: input.status,
            observedAtEpochMs: Date.now()
        })
    });
    await manager.acceptControlMessage(newALAckControlMessage(
        {
            v: 4,
            msgId: `ack-${input.fromPeerId}-${input.logicalRecipientPeerId}-${input.status}`,
            senderId: input.fromPeerId,
            ts: Date.now(),
            traceId: 'trace-rtc-origin-overlay-fixture'
        },
        signed.payload
    ));
}

/** A recipient's own NACK, signed by the room key every fixture session registers. */
export async function signRoomNackPayload(payload: ALNackPayload): Promise<ALNackPayload> {
    return (await signTestALReceiptControl(ROOM_PUBLICATION_CRYPTO, { type: 'nack', payload })).payload;
}

/** The origin room of `sessionIds`, each session live and registering the room key. */
export function createOriginSnapshot(sessionIds: readonly string[], snapshotVersion: number): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...ORIGIN_ROOM, sessionIds });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion,
            acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: 1, state: 'active' }
        },
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            expiresAtEpochMs: Date.now() + 600_000,
            publicationKey: ROOM_PUBLICATION_KEY
        }))
    };
}

/** The room of `a`, `b`, `c` and `d`, where `a`, `b` and `d` are sessions of one principal. */
export function createOriginPrincipalSnapshot(): GroupSnapshot {
    const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) =>
            ['a', 'b', 'd'].includes(session.sessionId) ? { ...session, principalId: ORIGIN_PRINCIPAL_REF.principalId } : session
        ),
        members: [...snapshot.members, { ...snapshot.members[0]!, principalId: ORIGIN_PRINCIPAL_REF.principalId }]
    };
}

/** The snapshot with the session `directorSessionId` appointed its room's director, the room's leader. */
export function toOriginDirectedSnapshot(snapshot: GroupSnapshot, directorSessionId: string, observedAtMs: number): GroupSnapshot {
    const principalId = snapshot.activeSessions.find((session) => session.sessionId === directorSessionId)?.principalId ??
        directorSessionId;
    const appointment = createRallarGroupDirectorAppointment({
        session: { clientId: principalId, sessionId: directorSessionId },
        now: observedAtMs
    });
    return {
        ...snapshot,
        group: { ...snapshot.group, metadata: mergeRallarGroupDirectorMetadata(snapshot.group.metadata, appointment) }
    };
}

export function createOriginOverlay(
    nextHopSessionIds: readonly string[],
    nextHopsBySessionId?: OverlayInfo['nextHopsBySessionId']
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
        provenance: 'server',
        state: 'active',
        overlayId: 'room',
        groupRef: ORIGIN_ROOM,
        topology: 'tree',
        name: 'Room',
        createdByClientId: 'a',
        createdAtEpochMs: 1,
        nextHopSessionIds,
        degreeLimit: 3,
        overlayVersion: 1,
        updatedAtEpochMs: 1,
        nextHopsBySessionId
    };
}

function createConnectionService(
    ready: { readonly peerIds: readonly string[]; },
    channels: Readonly<Record<string, CapturedChannel>>
): WebRtcConnectionService {
    const connection = new WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId: 'a',
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc-signaling'
    }, {
        faultPort: createPassThroughTransportFaultPort(),
        createOfferId: crypto.randomUUID.bind(crypto),
        nowEpochMs: () => Date.now(),
        writeRetainedSignalsDueNow: async () => []
    });
    vi.spyOn(connection, 'readyPeerIdsForLane').mockImplementation(() => ready.peerIds);
    vi.spyOn(connection, 'readPeer').mockImplementation((peerId) => {
        const channel = ready.peerIds.includes(peerId) ? channels[peerId]?.channel : undefined;
        return channel === undefined ? undefined : {
            peerId,
            connection: channel.peerConnection,
            channel,
            channels: new Map([['reliable', channel]]),
            media: new QRtcMediaChannel(channel.peerConnection, { peerId })
        };
    });
    return connection;
}

function createOpenChannel(peerId: string): CapturedChannel {
    const peerConnection = new QRtcPeerConnection({ send: async () => undefined }, {
        sessionId: 'a',
        peerSessionId: peerId,
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        isPolite: false
    }, { createOfferId: crypto.randomUUID.bind(crypto) });
    const channel = new QRtcDataChannel(peerConnection, {
        faultPort: createPassThroughTransportFaultPort(),
        peerId,
        dataChannelName: 'test'
    });
    const health = channel.readHealth();
    const sent: ALMessage[] = [];
    vi.spyOn(channel, 'readHealth').mockReturnValue({ ...health, readyState: 'open' });
    // As the reliable lane's `drop-new` overflow does, a send at the high watermark is dropped, never queued.
    vi.spyOn(channel, 'sendJson').mockImplementation((message) => {
        const { bufferedAmount, flowControl } = channel.readHealth();
        if (bufferedAmount >= flowControl.highWatermarkBytes) {
            return { status: 'dropped', reason: 'Back pressure', bufferedAmount };
        }
        sent.push(decodePersistedALMessageValue(message));
        return { status: 'sent', bufferedAmount: 0 };
    });
    return { channel, sent };
}
