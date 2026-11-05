import { computeGroupMoveHistoryPublication } from '@shared-server/rallar-system/group-state/move/group-move-outbox.ts';
import { computeWsOutboxProvenanceRecord, WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodePersistedALMessageRow } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { toALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { expect, it, onTestFinished } from 'vitest';
import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const scope = { applicationId: 'workspace-game', workspaceId: 'workspace-default' };
const principalRef = { ...scope, principalId: 'alice' };
const now = Date.now();
const publication = computeGroupMoveHistoryPublication({
    kind: 'terminal-retention',
    source: { ...scope, groupId: 'source/escaped+long' },
    moveId: 'private-move',
    moveCreatedAtEpochMs: now - 20000,
    completedAtEpochMs: now - 10000,
    dueAtEpochMs: now,
    principalIds: ['alice']
}, { createdAtEpochMs: now, retentionMs: 60000, serviceId: 'api-node', traceId: 'move-history-proof' });
const entry = publication.outbox[0].entry;
const message = decodePersistedALMessageRow(entry);

it('delivers a durable move invalidation through prepared native sends only to currently authenticated scoped account sessions', async () => {
    const repository = new FakeRuntimeStateRepository();
    for (const proof of publication.provenance) {
        if (proof.operation !== 'insert') {
            throw new Error('Expected move publication proof');
        }
        await repository.upsert({ namespace: proof.namespace, key: proof.key, value: proof.value, expireAtTimestamp: proof.expireAtTimestamp });
    }
    const recipients = ['original', 'replacement', 'co-member', 'other-scope', 'expired'];
    const reader = new WsOutboxProvenanceReader({ repository, nowMs: Date.now, readPrincipalSessionIds: async () => recipients });
    const socket = new JsonWebSocketServer();
    const natives = new Map<string, TestWebSocket>();
    for (const id of recipients) {
        const native = new TestWebSocket(`ws://${id}`);
        native.open();
        socket.addConnection(new ConnectionContext({ id, socket: native }));
        natives.set(id, native);
    }
    const engine = new InboxOutboxEngine();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const service = createDefaultWsQueueBoxServerService({
        name: 'api-node',
        socket,
        queueEngine: engine,
        outbox: stores.workQueue,
        outboundStores: stores,
        inboundVolatileStores: undefined,
        readProducerProvenance: (notice, row) => reader.readProducerProvenance(notice, row),
        readAuthenticatedConnectionScope: (connection) => ({
            scope: connection.id === 'other-scope' ? { ...scope, workspaceId: 'other' } : scope,
            principalId: connection.id === 'co-member' ? 'bob' : 'alice',
            expiresAtEpochMs: connection.id === 'expired' ? now - 1 : now + 60000
        })
    });
    onTestFinished(async () => {
        await service.dispose();
        await engine.stop();
    });
    expect(
        service.sendToTargetsWithResult({
            message,
            sentPositions: null,
            recipientScope: scope,
            recipientPrincipalId: 'bob',
            recipientSessionIds: recipients
        }).sentCount
    ).toBe(0);
    expect(service.sendToTargetsWithResult({ message, sentPositions: null, recipientSessionIds: recipients }).sentCount).toBe(0);
    await stores.workQueue.enqueue(entry);
    await engine.executeOnce();
    await expect.poll(() => natives.get('replacement')!.sent.length).toBe(1);
    expect(natives.get('original')!.sent).toHaveLength(1);
    for (const id of ['co-member', 'other-scope', 'expired']) {
        expect(natives.get(id)!.sent).toEqual([]);
    }
});

it.each(['state-sync', 'room-application'] as const)('rejects a digest-valid move invalidation from the %s producer', async (producerKind) => {
    const repository = new FakeRuntimeStateRepository();
    const proof = computeWsOutboxProvenanceRecord({
        entry,
        message,
        producerKind,
        target: { kind: 'scoped-account-view', principalRef },
        expiresAtMs: entry.audit.expiryTs.epochMilliseconds
    });
    await repository.upsert(proof);
    const reader = new WsOutboxProvenanceReader({ repository, nowMs: Date.now, readPrincipalSessionIds: async () => ['replacement'] });
    await expect(reader.readProducerProvenance(message, entry)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
});

it('accepts only prepared move recipients bound to their exact principal, scope and connection', () => {
    const prepared = {
        kind: 'scoped-recipient',
        peerId: 'replacement',
        connectionId: 'replacement',
        generationId: 'current-generation',
        recipientScope: scope,
        principalTargetId: 'alice',
        message: toALOutboundTransportMessage(message)
    };
    expect(decodeWsQueueBoxServerPreparedMessage(JSON.parse(JSON.stringify(prepared)), message, entry.key)).toEqual(prepared);
    for (const changed of [{ recipientScope: { ...scope, workspaceId: 'elsewhere' } }, { principalTargetId: 'bob' }, { peerId: 'other-connection' }]) {
        expect(() => decodeWsQueueBoxServerPreparedMessage({ ...prepared, ...changed }, message, entry.key)).toThrow();
    }
});
