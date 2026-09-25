import { describe, expect, it, onTestFinished } from 'vitest';

import { newALMulticastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

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
});
