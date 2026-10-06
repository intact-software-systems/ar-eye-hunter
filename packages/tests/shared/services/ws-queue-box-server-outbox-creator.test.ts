import { expect, it, onTestFinished } from 'vitest';

import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { newALReceiptControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy } from '@shared/queuebox/AppQueueIdentity.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

it('enqueues a browser room message with a queue creator that fits the durable column', async () => {
    const browserSessionId = 'browser-session-12345678901234567890';
    const outbox = new InMemoryQueueBox();
    const service = createDefaultWsQueueBoxServerService({
        readAuthenticatedConnectionScope: () => undefined,
        name: 'server',
        socket: new JsonWebSocketServer(),
        outbox,
        queueEngine: new InboxOutboxEngine(),
        targetResolver: {
            resolveBroadcastRecipients: () => [{ peerId: 'recipient', connectionId: 'recipient' }]
        }
    });
    onTestFinished(() => service.dispose());
    const message = newALBroadcastMessage(
        browserSessionId,
        newALRoute('room.chat', 'room-1', 'message-1'),
        'room',
        'chat.message.v1',
        {},
        {
            groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' },
            ttlMs: 30_000,
            reliability: 'at-least-once',
            ack: 'all-logical-recipients',
            qos: { durability: { algo: 'local-outbox' } }
        }
    );

    const result = await service.enqueueOutboxIfAbsent(message, { admittedAudience: ['recipient'], recipientScope: undefined });
    const row = result.entry === undefined ? undefined : await outbox.getItem(result.entry.key);

    expect(result.verdict.kind).toBe('admitted');
    expect(row?.typeId).toBe('WS_OUTBOX');
    expect(row?.audit.createdBy).toBe(toAppQueueCreatedBy(browserSessionId));
    expect(row?.audit.createdBy.length).toBeLessThanOrEqual(16);
    expect(row === undefined ? undefined : decodePersistedALMessage(row.resource).audit?.createdBy)
        .toBe(browserSessionId);
});

it('enqueues a server receipt with a queue creator that fits the durable column', async () => {
    const serverId = 'server-instance-12345678901234567890';
    const outbox = new InMemoryQueueBox();
    const service = createDefaultWsQueueBoxServerService({
        readAuthenticatedConnectionScope: () => undefined,
        name: serverId,
        socket: new JsonWebSocketServer(),
        outbox,
        queueEngine: new InboxOutboxEngine(),
        targetResolver: {
            resolvePeerRecipients: () => [{ peerId: 'origin', connectionId: 'origin' }]
        }
    });
    onTestFinished(() => service.dispose());
    const nowMs = Date.now();
    const message = newALReceiptControlMessage(
        { v: 3, msgId: 'receipt-1', senderId: serverId, ts: nowMs },
        {
            msgId: 'message-1',
            originPeerId: 'origin',
            expectedRecipientPeerIds: ['recipient'],
            confirmedRecipientPeerIds: [],
            snapshotVersion: 1,
            phase: 'admitted',
            observedAtEpochMs: nowMs
        }
    );

    const result = await service.enqueueOutboxIfAbsent(message);
    const row = result.entry === undefined ? undefined : await outbox.getItem(result.entry.key);

    expect(result.verdict.kind).toBe('admitted');
    expect(row?.typeId).toBe('WS_OUTBOX');
    // A receipt carries no message audit, so its row takes the owner's fallback creator, never the raw server id.
    expect(row?.audit.createdBy)
        .toBe(
            QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX).audit
                .createdBy
        );
    expect(row?.audit.createdBy.length).toBeLessThanOrEqual(16);
    expect(row?.audit.createdBy).not.toBe(serverId);
    expect(row === undefined ? undefined : decodePersistedALMessage(row.resource).id.senderId).toBe(
        serverId
    );
});
