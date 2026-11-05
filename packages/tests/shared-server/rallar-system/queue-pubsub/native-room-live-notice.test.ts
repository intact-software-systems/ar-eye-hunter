import { decodeLiveWsNotice, encodeLiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { partitionRoomSnapshotPublication } from '@shared-server/rallar-system/queue-pubsub/partition-room-snapshot-publication.ts';
import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { computeServerRoomPublicationAudience } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { toALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { validateWsQueueBoxServerRecipientAuthority } from '@shared/services/ws-queue-box-server/scope/requires-ws-queue-box-server-recipient-scope.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { describe, expect, it, onTestFinished } from 'vitest';
import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

const groupRef = { applicationId: 'game-a', workspaceId: 'region-a', groupId: 'room' };
const topic = 'rallar.server.room-snapshot';
const channel = 'live';
const generations = { alice: 'generation-a', spectator: 'generation-s' };
function publication(size: number) {
    const message = newALBroadcastMessage('room-producer', newALRoute(topic, 'room', 'game'), 'room', topic, { data: 'a'.repeat(size) }, {
        groupRef,
        ttlMs: 5000
    });
    return {
        message,
        channel,
        publisherId: 'server-a',
        expiresAtMs: message.constraints!.expiresAtMs!,
        scope: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
        audience: { mode: 'generation-room' as const, groupRef, recipientSessionIds: ['alice', 'spectator'], generations }
    };
}

describe('server-only native room notice', () => {
    it('preserves the frozen sessions and socket generations beyond PostgreSQL inline capacity', () => {
        const large = publication(11000);
        const encoded = encodeLiveWsNotice(large);
        expect(encoded.kind).toBe('fragmented');
        if (encoded.kind !== 'fragmented') {
            throw new Error('Expected fragmented notice');
        }
        expect(decodeLiveWsNotice(encoded.notice, channel, Date.now())).toEqual(encoded.notice);
        expect(encoded.notice).toMatchObject({ audience: large.audience });
    });

    // The producer is admitted once, by the topic registry at publication; the notice carries only the fenced audience.
    it('rejects a native notice with only session IDs, extra generations or wrong target scope', () => {
        const input = publication(20);
        expect(() => encodeLiveWsNotice({ ...input, audience: { mode: 'room', groupRef, recipientSessionIds: ['alice'] } })).toThrow();
        expect(() => encodeLiveWsNotice({ ...input, audience: { ...input.audience, generations: { ...generations, outsider: 'not-admitted' } } })).toThrow();
        expect(() => encodeLiveWsNotice({ ...input, scope: { ...input.scope, workspaceId: 'elsewhere' } })).toThrow();
    });
});

it('writes only frozen generations, and drops a failed socket so its replacement can hydrate', () => {
    const input = publication(20);
    const socket = new JsonWebSocketServer();
    const clients = new Map<string, TestWebSocket>();
    for (const [id, generationId] of [['alice', 'generation-a'], ['spectator', 'generation-s'], ['outsider', 'generation-o']]) {
        const native = new TestWebSocket('ws://test/socket');
        native.open();
        socket.addConnection(new ConnectionContext({ id, generationId, socket: native }));
        clients.set(id, native);
    }
    const engine = new InboxOutboxEngine();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const service = createDefaultWsQueueBoxServerService({
        name: 'mixed-node',
        socket,
        queueEngine: engine,
        outbox: stores.workQueue,
        outboundStores: stores,
        inboundVolatileStores: undefined,
        readAuthenticatedConnectionScope: (connection) => ({
            scope: input.scope,
            principalId: connection.id,
            expiresAtEpochMs: Date.now() + 60000
        })
    });
    onTestFinished(async () => {
        await service.dispose();
        await engine.stop();
    });
    const send = {
        message: input.message,
        sentPositions: null,
        recipientSessionIds: input.audience.recipientSessionIds,
        recipientScope: input.scope,
        roomSessionGenerations: input.audience.generations,
        requireAuthenticatedRecipient: true
    };
    expect(service.sendToTargetsWithResult({ ...send, roomSessionGenerations: undefined }).sentCount).toBe(0);
    expect(service.sendToTargetsWithResult(send).sentCount).toBe(2);
    expect(clients.get('outsider')!.sent).toEqual([]);
    const spectator = clients.get('spectator')!;
    spectator.send = () => {
        throw new Error('link lost');
    };
    expect(service.sendToTargetsWithResult(send).failedCount).toBe(1);
    expect(spectator.closedWith?.code).toBe(1011);
    const replacement = new TestWebSocket('ws://test/reconnect');
    replacement.open();
    socket.addConnection(new ConnectionContext({ id: 'spectator', generationId: 'new-generation', socket: replacement }));
    expect(service.sendToTargetsWithResult(send).sentCount).toBe(1);
    expect(replacement.sent).toEqual([]);
    expect(service.sendToTargetsWithResult({ ...send, roomSessionGenerations: { ...generations, spectator: 'new-generation' } }).sentCount).toBe(2);
});

it('does not grant a replacement socket room frames from its predecessor room presence', () => {
    const snapshot = createGroupSnapshot(2, ['current', 'reconnected']);
    const ref = snapshot.group;
    const message = newALBroadcastMessage('room-producer', newALRoute(topic, ref.groupId, 'game'), 'room', topic, {}, { groupRef: ref, ttlMs: 5000 });
    const result = computeServerRoomPublicationAudience({
        message,
        producerId: 'room-producer',
        topic: { participation: 'server', serverProducerIds: ['room-producer'] },
        nowEpochMs: Date.now(),
        authority: {
            snapshot,
            subscriptions: [],
            liveSessionGenerations: {
                current: ['ws-generation-current'],
                reconnected: ['replacement-before-room-join']
            }
        }
    });
    expect(result?.right?.recipientConnectionGenerationIds).toEqual({ current: 'ws-generation-current' });
    expect(result?.right?.sessions.map((session) => session.sessionId)).toEqual(['current']);
});

it('partitions large captured audiences without losing or duplicating a session, and fragments only the partitions that need it', () => {
    const ids = Array.from({ length: 2200 }, (_, i) => 'session-' + i.toString().padStart(100, '0'));
    for (const size of [20, 11000]) {
        const input = publication(size);
        const audience = { ...input.audience, recipientSessionIds: ids, generations: Object.fromEntries(ids.map((id) => [id, 'g-' + id])) };
        const partitions = partitionRoomSnapshotPublication({ ...input, audience }).right!;
        expect(partitions.length).toBeGreaterThan(1);
        expect(partitions.flatMap((part) => part.audience.recipientSessionIds)).toEqual(ids);
        expect(partitions.map((part) => encodeLiveWsNotice(part).kind)).toEqual(partitions.map(() => size === 20 ? 'inline' : 'fragmented'));
    }
});

it('rejects live room snapshots in captured durable admission and persisted repair even when the room matches', () => {
    const { message } = publication(20);
    const prepared = {
        kind: 'room-recipient',
        peerId: 'other',
        connectionId: 'other',
        generationId: 'generation-other',
        message: toALOutboundTransportMessage(message)
    };
    expect(validateWsQueueBoxServerRecipientAuthority(message, { admittedAudience: ['other'] }, message.route)).not.toEqual([]);
    expect(() => decodeWsQueueBoxServerPreparedMessage(prepared, message, message.route)).toThrow(/live/i);
});

it('refuses the whole partitioned publication when one recipient fits no private notice', () => {
    const input = publication(20);
    const huge = 'session-' + 'x'.repeat(300_000);
    const oversized = partitionRoomSnapshotPublication({
        ...input,
        audience: { ...input.audience, recipientSessionIds: ['alice', huge], generations: { alice: 'generation-a', [huge]: 'g' } }
    });
    const ungenerated = partitionRoomSnapshotPublication({ ...input, audience: { ...input.audience, generations: { alice: 'generation-a' } } });

    expect(oversized.left).toMatch(/single room snapshot recipient/u);
    expect(ungenerated.left).toMatch(/frozen generations/u);
});

it('publishes a registered server topic only for its listed producer, only live, to each member on its recorded generation', async () => {
    const snapshot = createGroupSnapshot(2, ['current', 'reconnected']);
    const room = { applicationId: snapshot.group.applicationId, workspaceId: snapshot.group.workspaceId, groupId: snapshot.group.groupId };
    const socket = new JsonWebSocketServer();
    const clients = new Map<string, TestWebSocket>();
    // The reconnected session's socket is a replacement its room presence has not recorded yet.
    for (const [id, generationId] of [['current', 'ws-generation-current'], ['reconnected', 'replacement']]) {
        const native = new TestWebSocket('ws://test/socket');
        native.open();
        socket.addConnection(new ConnectionContext({ id, generationId, socket: native }));
        clients.set(id, native);
    }
    const engine = new InboxOutboxEngine();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const service = createDefaultWsQueueBoxServerService({
        name: 'server-node',
        socket,
        queueEngine: engine,
        outbox: stores.workQueue,
        outboundStores: stores,
        inboundVolatileStores: undefined,
        readAuthenticatedConnectionScope: () => ({
            scope: { applicationId: room.applicationId, workspaceId: room.workspaceId },
            expiresAtEpochMs: Date.now() + 60000
        })
    });
    onTestFinished(async () => {
        await service.dispose();
        await engine.stop();
    });
    const router = new RallarServerWsRouter(service, {
        grantedTopics: new WsGrantedTopicSet(),
        readServerPublishAudience: createServerPublishRoomAudienceReader({
            readGroupSnapshot: async () => snapshot,
            readPublicationAuthority: async () => ({
                snapshot,
                subscriptions: [],
                liveSessionGenerations: { current: ['ws-generation-current'], reconnected: ['replacement'] }
            }),
            nowEpochMs: Date.now
        })
    }).defineTopic({ topicId: topic, scope: 'room', fanout: 'live-only', participation: 'server', serverProducerIds: ['room-producer'] });
    const message = newALBroadcastMessage('room-producer', newALRoute(topic, room.groupId, 'game'), 'room', topic, {}, { groupRef: room, ttlMs: 5000 });

    expect(await router.publish({ message, producerId: 'intruder', fanout: 'live-only' })).toMatchObject({ status: 'refused', refusal: 'topic-not-granted' });
    expect((await router.publish({ message, producerId: 'room-producer', fanout: 'outbox' })).status).toBe('failed');
    expect(clients.get('current')!.sent).toEqual([]);
    expect((await router.publish({ message, producerId: 'room-producer', fanout: 'live-only' })).status).toBe('sent-live');
    expect([clients.get('current')!.sent.length, clients.get('reconnected')!.sent.length]).toEqual([1, 0]);
    expect(() => router.defineTopic({ topicId: 'room.feed', scope: 'room', fanout: 'live-only', participation: 'server', serverProducerIds: [] }))
        .toThrow(/reserved live room topic/u);
});
