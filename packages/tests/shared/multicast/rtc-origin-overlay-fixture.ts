import { onTestFinished, vi } from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import {
    newALMulticastMessage,
    type ALMessage,
    type ALTargets
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
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
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { toCircuitBreaker, type CircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import {
    createPassThroughTransportFaultPort,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';

export interface CapturedChannel {
    readonly channel: QRtcDataChannel;
    readonly sent: ALMessage[];
}

/** The RTC origin `a` in one room, with an open channel to every peer it may address. */
export interface RtcOriginOverlayFixture {
    readonly manager: WebRtcOverlayMulticastManager;
    readonly resources: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>;
    readonly groups: LatestRepository<string, GroupSnapshot>;
    readonly overlays: LatestRepository<string, OverlayInfo>;
    readonly channels: Readonly<Record<string, CapturedChannel>>;
    readonly ready: { peerIds: readonly string[]; };
    readonly settlements: readonly ALDeliverySettlement[];
    readonly diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];
}

export interface RtcOriginOverlayFixtureInput {
    readonly snapshot: GroupSnapshot;
    /** The overlay next hops of the origin, each with an open channel. */
    readonly nextHopPeerIds: readonly string[];
    readonly circuitBreaker?: CircuitBreaker;
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
}

export interface OriginAcknowledgementInput {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly status: ALAckStatus;
}

export const ORIGIN_ROOM: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

const CHANNEL_PEER_IDS = ['b', 'c', 'd', 'r'];

export function createRtcOriginOverlayFixture(input: RtcOriginOverlayFixtureInput): RtcOriginOverlayFixture {
    const ready = { peerIds: input.nextHopPeerIds };
    const channels = Object.fromEntries(CHANNEL_PEER_IDS.map((peerId) => [peerId, createOpenChannel(peerId)]));
    const connection = createConnectionService(ready, channels);
    const groups = new LatestRepository<string, GroupSnapshot>();
    groups.accept('room', input.snapshot);
    const overlays = new LatestRepository<string, OverlayInfo>();
    overlays.accept('room', createOriginOverlay(input.nextHopPeerIds));
    const resources = createDefaultALOutboundRuntimeResources({
        decodePrepared: decodeALOutboundTransportMessage,
        stores: input.stores,
        volatileStores: input.volatileStores
    });
    const settlements: ALDeliverySettlement[] = [];
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const manager = new WebRtcOverlayMulticastManager({
        connectionService: connection,
        groupCache: groups,
        overlayCache: overlays,
        multicasterFactory: (overlayId) => new WebRtcOverlayMulticastService(overlayId, connection),
        qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, input.qosProvider),
        outboundDiagnostics: (event) => diagnostics.push(event),
        outboundSettlements: (settlement) => {
            settlements.push(settlement);
            input.onSettlement?.(settlement);
        },
        outboundRuntime: resources,
        circuitBreaker: input.circuitBreaker ?? toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        faultPort: input.faultPort ?? createPassThroughTransportFaultPort(),
        dequeueResilience: createDefaultALOutboundDequeueResilience()
    });
    onTestFinished(() => manager.dispose());
    return { manager, resources, groups, overlays, channels, ready, settlements, diagnostics };
}

export function createOriginReceiverMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: resourceId },
        { ack: 'all-logical-recipients', reliability: 'at-least-once', ttlMs: 30_000 }
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
    await manager.acceptControlMessage(newALAckControlMessage(
        {
            v: 3,
            msgId: `ack-${input.fromPeerId}-${input.logicalRecipientPeerId}-${input.status}`,
            senderId: input.fromPeerId,
            ts: Date.now()
        },
        {
            ackedMsgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            carrier: 'rtc',
            status: input.status,
            observedAtEpochMs: Date.now()
        }
    ));
}

export function createOriginSnapshot(sessionIds: readonly string[], snapshotVersion: number): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...ORIGIN_ROOM, sessionIds });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion,
            acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: 1, state: 'active' }
        },
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 600_000 }))
    };
}

export const ORIGIN_PRINCIPAL_REF = {
    applicationId: ORIGIN_ROOM.applicationId,
    workspaceId: ORIGIN_ROOM.workspaceId,
    principalId: 'principal-1'
} as const;

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
export function toOriginDirectedSnapshot(snapshot: GroupSnapshot, directorSessionId: string): GroupSnapshot {
    const principalId = snapshot.activeSessions.find((session) => session.sessionId === directorSessionId)?.principalId ??
        directorSessionId;
    const appointment = createRallarGroupDirectorAppointment({
        session: { clientId: principalId, sessionId: directorSessionId },
        now: Date.now()
    });
    return {
        ...snapshot,
        group: { ...snapshot.group, metadata: mergeRallarGroupDirectorMetadata(snapshot.group.metadata, appointment) }
    };
}

export function createOriginOverlay(nextHopSessionIds: readonly string[]): OverlayInfo {
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
        updatedAtEpochMs: 1
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
    }, { faultPort: createPassThroughTransportFaultPort(), createOfferId: crypto.randomUUID.bind(crypto), nowEpochMs: () => Date.now() });
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
