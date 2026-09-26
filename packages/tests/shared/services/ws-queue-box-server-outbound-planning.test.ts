import { describe, expect, it, onTestFinished } from 'vitest';

import { newALMulticastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { drainEngine } from '../alm/outbound-runtime-test-fixture.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('WS server outbound planning', () => {
    it('tracks the receipt under the ack algorithm the send resolved', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'ws-planning',
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            namespace: 'ws-planning',
            backend,
            supersedenceTrackTtlMs: 300_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const server = new JsonWebSocketServer();
        const native = new TestWebSocket('ws://planning');
        native.open();
        const context = new ConnectionContext({ id: 'connection', socket: native });
        server.addConnection(context);
        const service = createDefaultWsQueueBoxServerService({
            name: 'server',
            socket: server,
            outbox: new InMemoryQueueBox(),
            outboundStores: { admissionStore: store, workQueue: backend.workQueue },
            queueEngine: new InboxOutboxEngine(),
            targetResolver: {
                resolvePeerRecipients: () => [{ peerId: 'peer', connectionId: context.id }],
                resolveGroupRecipients: () => [{ peerId: 'peer', connectionId: context.id }],
                resolveBroadcastRecipients: () => [],
                resolvePeerIdForConnection: () => 'peer'
            }
        });
        onTestFinished(() => service.dispose());
        const message = newALMulticastMessage(
            'server',
            { topicId: 'room.chat', contextId: 'room', resourceId: 'receipt-mode' },
            { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
            'chat.message.v1',
            {},
            { ttlMs: 30_000, qos: { ack: { algo: 'receiver' }, durability: { algo: 'volatile' } } }
        );
        const unicast = newALUnicastMessage(
            'server',
            { topicId: 'chat', contextId: 'direct', resourceId: 'receipt-unicast' },
            'peer',
            'chat.message.v1',
            {},
            { ttlMs: 30_000, qos: { ack: { algo: 'receiver' }, durability: { algo: 'volatile' } } }
        );

        await service.enqueueOutboxIfAbsent(message);
        expect((await service.enqueueOutboxIfAbsent(unicast)).verdict).toMatchObject({
            kind: 'refused',
            reason: 'unsupported',
            detail: 'ack receiver is unsupported for ws unicast targets'
        });

        expect(await store.readReceiptState({ originPeerId: 'server', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['peer'], ackedPeerIds: [] });
    });

    it('expects the frozen audience of an outbox-fanned multicast, never a session that joined after it froze', async () => {
        const fixture = createPlanningFixture(['b', 'c', 'late-joiner']);
        const frozen = newALMulticastMessage(
            'a',
            { topicId: 'room.chat', contextId: ROOM.groupId, resourceId: 'frozen-audience' },
            ROOM,
            'chat.message.v1',
            {},
            { ttlMs: 30_000, reliability: 'at-least-once', ack: 'receiver' }
        );
        const message = { ...frozen, targets: { ...frozen.targets!, recipientPeerIds: ['b', 'c'], snapshotVersion: 3 } };

        await fixture.service.enqueueOutboxIfAbsent(message);
        await drainEngine(fixture.engine);
        await expect.poll(() => fixture.sockets.get('c')!.sent.length).toBe(1);
        await drainEngine(fixture.engine);

        expect(await fixture.store.readReceiptState({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'], ackedPeerIds: [] });
        expect(fixture.sockets.get('late-joiner')!.sent).toEqual([]);
    });
});

interface PlanningFixture {
    readonly service: WsQueueBoxServerService;
    readonly store: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>;
    readonly engine: InboxOutboxEngine;
    readonly sockets: ReadonlyMap<string, TestWebSocket>;
}

/** One server whose room resolves every session named here, each on its own open connection. */
function createPlanningFixture(roomPeerIds: readonly string[]): PlanningFixture {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'ws-planning-frozen',
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        namespace: 'ws-planning-frozen',
        backend,
        supersedenceTrackTtlMs: 300_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const server = new JsonWebSocketServer();
    const sockets = new Map<string, TestWebSocket>();
    for (const peerId of roomPeerIds) {
        const native = new TestWebSocket(`ws://${peerId}`);
        native.open();
        server.addConnection(new ConnectionContext({ id: peerId, socket: native }));
        sockets.set(peerId, native);
    }
    const roomRecipients: readonly WsServerResolvedRecipient[] = roomPeerIds.map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        socket: server,
        outbox: backend.workQueue,
        outboundStores: { admissionStore: store, workQueue: backend.workQueue },
        queueEngine: engine,
        targetResolver: { resolveGroupRecipients: () => roomRecipients }
    });
    onTestFinished(() => service.dispose());
    return { service, store, engine, sockets };
}
