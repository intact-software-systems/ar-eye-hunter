import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage, type ALTargets } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundEnqueueResult, ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { computeFrozenAudience } from '@shared/multicast/web-rtc-overlay-frozen-audience.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';

interface CapturedChannel {
    readonly channel: QRtcDataChannel;
    readonly sent: ALMessage[];
}

interface FrozenAudienceFixture {
    readonly manager: WebRtcOverlayMulticastManager;
    readonly resources: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>;
    readonly groups: LatestRepository<string, GroupSnapshot>;
    readonly overlays: LatestRepository<string, OverlayInfo>;
    readonly channels: Readonly<Record<string, CapturedChannel>>;
    readonly ready: { peerIds: readonly string[]; };
}

const ROOM: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('RTC frozen room audience', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('freezes the audience at admission and keeps expecting it after a later join and leave', async () => {
        const fixture = createFixture();
        const message = createReceiverMulticast('frozen');

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(sentTargets(fixture.channels.b!)).toEqual([frozenTargets(['b', 'c'], 4)]);
        expect(sentTargets(fixture.channels.c!)).toEqual([frozenTargets(['b', 'c'], 4)]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'] });

        fixture.groups.accept('room', createSnapshot(['a', 'b', 'c', 'd'], 5));
        fixture.groups.accept('room', createSnapshot(['a', 'b', 'd'], 6));
        fixture.overlays.accept('room', createOverlay(['b', 'd']));
        fixture.ready.peerIds = ['b', 'd'];
        await vi.advanceTimersByTimeAsync(10_000);

        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'] });
        expect(fixture.channels.d!.sent).toEqual([]);
    });

    it('re-admits the unfrozen original as the duplicate of its frozen canonical', async () => {
        const fixture = createFixture();
        const message = createReceiverMulticast('resent');

        await enqueueAndDrain(fixture.manager, message);
        fixture.groups.accept('room', createSnapshot(['a', 'b', 'c', 'd'], 5));
        const resent = await enqueueAndDrain(fixture.manager, message);

        expect(resent.verdict.kind).toBe('duplicate');
        expect(resent.message.targets).toEqual(frozenTargets(['b', 'c'], 4));
    });

    it('keeps a hop receipt on the next hops the plan reaches', async () => {
        const fixture = createFixture();
        const message = { ...createReceiverMulticast('hop'), qos: { ack: { algo: 'hop' } } } as const;

        await enqueueAndDrain(fixture.manager, message);

        expect(sentTargets(fixture.channels.b!)).toEqual([frozenTargets(['b', 'c'], 4)]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'hop', expectedPeerIds: ['b', 'c'] });
    });
});

describe('computeFrozenAudience', () => {
    it('names every session of the identified snapshot except the origin, at that snapshot version', () => {
        expect(computeFrozenAudience({ room: createSnapshot(['a', 'b', 'c'], 4), selfPeerId: 'a' }))
            .toEqual({ recipientPeerIds: ['b', 'c'], snapshotVersion: 4 });
    });
});

function createReceiverMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ROOM,
        'chat.message.v1',
        { text: resourceId },
        { ack: 'all-logical-recipients', reliability: 'at-least-once', ttlMs: 30_000 }
    );
}

function frozenTargets(recipientPeerIds: readonly string[], snapshotVersion: number): ALTargets {
    return { mode: 'multicast', groupRef: ROOM, recipientPeerIds, snapshotVersion };
}

function sentTargets(captured: CapturedChannel): readonly unknown[] {
    return captured.sent.map((message) => JSON.parse(JSON.stringify(message.targets)));
}

function createFixture(): FrozenAudienceFixture {
    const ready = { peerIds: ['b', 'c'] as readonly string[] };
    const channels = Object.fromEntries(['b', 'c', 'd'].map((peerId) => [peerId, createOpenChannel(peerId)]));
    const connection = createConnectionService(ready, channels);
    const groups = new LatestRepository<string, GroupSnapshot>();
    groups.accept('room', createSnapshot(['a', 'b', 'c'], 4));
    const overlays = new LatestRepository<string, OverlayInfo>();
    overlays.accept('room', createOverlay(['b', 'c']));
    const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
    const manager = new WebRtcOverlayMulticastManager({
        connectionService: connection,
        groupCache: groups,
        overlayCache: overlays,
        multicasterFactory: (overlayId) => new WebRtcOverlayMulticastService(overlayId, connection),
        qosProvider: undefined,
        outboundDiagnostics: undefined,
        outboundSettlements: undefined,
        outboundRuntime: resources,
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        dequeueResilience: createDefaultALOutboundDequeueResilience()
    });
    onTestFinished(() => manager.dispose());
    return { manager, resources, groups, overlays, channels, ready };
}

async function enqueueAndDrain(
    manager: WebRtcOverlayMulticastManager,
    message: ALMessage
): Promise<ALOutboundEnqueueResult> {
    const result = await manager.enqueueIfAbsent(message);
    await vi.advanceTimersByTimeAsync(0);
    return result;
}

function createSnapshot(sessionIds: readonly string[], snapshotVersion: number): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...ROOM, sessionIds });
    return {
        ...snapshot,
        group: { ...snapshot.group, snapshotVersion },
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 600_000 }))
    };
}

function createOverlay(nextHopSessionIds: readonly string[]): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
        provenance: 'server',
        state: 'active',
        overlayId: 'room',
        groupRef: ROOM,
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
        faultPort: createPassThroughTransportFaultPort(),
        rtcSignalingTopicId: 'rtc-signaling'
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
    });
    const channel = new QRtcDataChannel(peerConnection, {
        faultPort: createPassThroughTransportFaultPort(),
        peerId,
        dataChannelName: 'test'
    });
    const health = channel.readHealth();
    const sent: ALMessage[] = [];
    vi.spyOn(channel, 'readHealth').mockReturnValue({ ...health, readyState: 'open' });
    vi.spyOn(channel, 'sendJson').mockImplementation((message) => {
        sent.push(decodePersistedALMessageValue(message));
        return { status: 'sent', bufferedAmount: 0 };
    });
    return { channel, sent };
}
