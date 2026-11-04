import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { computeViewInvalidationPublication } from '@shared-server/rallar-system/websocket/outbox/compute-view-invalidation-publication.ts';
import { WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodePersistedALMessageRow } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { decodeViewInvalidation, decodeViewInvalidationMessage, decodeViewResync } from '@shared/api/view-invalidation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { validateWsQueueBoxServerRecipientAuthority } from '@shared/services/ws-queue-box-server/scope/requires-ws-queue-box-server-recipient-scope.ts';
import { toWsQueueBoxServerCapturedSendInput } from '@shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-captured-send-input.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { describe, expect, it, onTestFinished } from 'vitest';
import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const scope = { applicationId: 'app', workspaceId: 'workspace' };
const publication = computeViewInvalidationPublication({
    resource: 'party',
    scope,
    principalIds: ['alice'],
    changeId: 'change-1',
    createdAtEpochMs: Date.now(),
    retentionMs: 60000,
    serviceId: 'server-a',
    traceId: 'trace'
});
const entry = publication.outbox[0]!.entry;
const message = decodePersistedALMessageRow(entry);

async function proofRepository() {
    const repository = new FakeRuntimeStateRepository();
    for (const record of publication.provenance) {
        if (record.operation !== 'insert') {
            throw new Error('Expected insert-only provenance');
        }
        await repository.upsert(record.namespace, record.key, record.value, record.expireAtTimestamp);
    }
    return repository;
}

describe('account view invalidation authority', () => {
    it('strictly decodes notice and transport identities, refusing cross-scope and group broadcasts', () => {
        const notice = { version: 1, resource: 'party', scope, principalId: 'alice', changeId: 'change-1' };
        expect(decodeViewInvalidationMessage(message)).toEqual(notice);
        for (
            const invalid of [{ ...notice, extra: true }, { ...notice, version: 2 }, { ...notice, resource: 'unknown' }, {
                ...notice,
                scope: { applicationId: 'app' }
            }, { ...notice, changeId: '' }]
        ) {
            expect(() => decodeViewInvalidation(invalid)).toThrow();
        }
        expect(decodeViewResync({ version: 1 })).toEqual({ version: 1 });
        expect(() => decodeViewResync({ version: 1, partyId: 'private' })).toThrow();
        expect(() =>
            decodeViewInvalidationMessage({ ...message, targets: { mode: 'broadcast', scope: 'principal', principalRef: { ...scope, principalId: 'bob' } } })
        ).toThrow();
        expect(() =>
            decodeViewInvalidationMessage({
                ...message,
                targets: { mode: 'broadcast', scope: 'principal', principalRef: { ...scope, principalId: 'alice' }, groupRef: { ...scope, groupId: 'room' } }
            })
        ).toThrow();
        expect(() => decodeViewInvalidationMessage({ ...message, payload: { ...message.payload, typeId: 'app.forged' } })).toThrow();
    });

    it('resolves sessions at delivery after the mutation commit, and binds proof to the exact notice', async () => {
        const repository = await proofRepository();
        const activeSessions = ['old-session'];
        const reader = new WsOutboxProvenanceReader({
            repository,
            nowMs: Date.now,
            readPrincipalSessionIds: async (ref) => {
                expect(ref).toEqual({ ...scope, principalId: 'alice' });
                return [...activeSessions];
            }
        });
        // This session connected after the publication was computed and read the predecessor before its commit.
        activeSessions.push('new-session');
        expect(await reader.readProducerProvenance(message, entry)).toEqual({
            admittedAudience: ['old-session', 'new-session'],
            recipientScope: scope,
            principalTargetId: 'alice'
        });
        const forged = {
            ...message,
            payload: {
                ...message.payload,
                resource: JSON.stringify({
                    ...JSON.parse(message.payload.resource),
                    principalId: 'bob'
                })
            }
        };
        await expect(reader.readProducerProvenance(forged, { ...entry, resource: JSON.stringify(forged) }))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        const missingReader = new WsOutboxProvenanceReader({ repository, nowMs: Date.now });
        await expect(missingReader.readProducerProvenance(message, entry)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('preserves a session-read failure for retry instead of classifying an unavailable database as corrupt provenance', async () => {
        const repository = await proofRepository();
        const failure = new Error('Session read unavailable');
        const reader = new WsOutboxProvenanceReader({
            repository,
            nowMs: Date.now,
            readPrincipalSessionIds: async () => {
                throw failure;
            }
        });
        await expect(reader.readProducerProvenance(message, entry)).rejects.toBe(failure);
    });

    it.each(['local', 'remote'] as const)('delivers the durable outbox through the %s cluster path to own sessions only', async (placement) => {
        const repository = await proofRepository();
        const reader = new WsOutboxProvenanceReader({ repository, nowMs: Date.now, readPrincipalSessionIds: async () => ['alice', 'bob'] });
        const socket = new JsonWebSocketServer();
        const natives = new Map<string, TestWebSocket>();
        for (const id of ['alice', 'bob']) {
            const native = new TestWebSocket(`ws://${id}`);
            native.open();
            natives.set(id, native);
            if (placement === 'local') {
                socket.addConnection(new ConnectionContext({ id, socket: native }));
            }
        }
        const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
        const engine = new InboxOutboxEngine();
        const service = createDefaultWsQueueBoxServerService({
            name: 'server-a',
            socket,
            inboundVolatileStores: undefined,
            outbox: stores.workQueue,
            outboundStores: stores,
            queueEngine: engine,
            targetResolver: { requiresFrozenAudience: () => false, resolveBroadcastRecipients: () => [] },
            readProducerProvenance: (msg, row) => reader.readProducerProvenance(msg, row),
            readAuthenticatedConnectionScope: (connection) => ({ scope, principalId: connection.id, expiresAtEpochMs: Date.now() + 60000 })
        });
        onTestFinished(async () => {
            await service.dispose();
            await engine.stop();
        });
        const bridge = new AccountViewBridge();
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: service,
            bridge,
            channel: 'events',
            publisherId: 'local',
            filterEligibleCapturedSessionIds: async (input) => input.candidateSessionIds
        });
        await stores.workQueue.enqueue(entry);
        await engine.executeOnce();
        await expect.poll(() => bridge.published.length).toBe(1);
        if (placement === 'remote') {
            for (const [id, native] of natives) {
                socket.addConnection(new ConnectionContext({ id, socket: native }));
            }
            await bridge.subscriber?.({ ...bridge.published[0]!, publisherId: 'remote' });
        }
        await expect.poll(() => natives.get('alice')!.sent.length).toBe(1);
        expect(natives.get('bob')!.sent).toEqual([]);
    });

    it('checks current authenticated account and scope on the actual captured cluster send', () => {
        const socket = new JsonWebSocketServer();
        const natives = new Map<string, TestWebSocket>();
        for (const id of ['alice', 'bob', 'other-scope', 'unauthenticated']) {
            const native = new TestWebSocket(`ws://${id}`);
            native.open();
            natives.set(id, native);
            socket.addConnection(new ConnectionContext({ id, socket: native }));
        }
        const service = createDefaultWsQueueBoxServerService({
            name: 'receiver',
            socket,
            inboundVolatileStores: undefined,
            outbox: new InMemoryQueueBox(new Map()),
            readAuthenticatedConnectionScope: (connection) =>
                connection.id === 'unauthenticated' ? undefined : {
                    scope: connection.id === 'other-scope' ? { ...scope, workspaceId: 'elsewhere' } : scope,
                    principalId: connection.id === 'bob' ? 'bob' : 'alice',
                    expiresAtEpochMs: Date.now() + 60000
                }
        });
        onTestFinished(() => service.dispose());
        const policy = {
            persist: true,
            ackTracking: null,
            retryTracking: null,
            repairTracking: null,
            supersedenceTracking: null,
            admittedAudience: [...natives.keys()],
            recipientScope: scope,
            principalTargetId: 'alice'
        };
        expect(validateWsQueueBoxServerRecipientAuthority(message, policy, entry.key)).toEqual([]);
        expect(validateWsQueueBoxServerRecipientAuthority(message, { ...policy, principalTargetId: 'bob' }, entry.key)).not.toEqual([]);
        const result = service.sendToTargetsWithResult(toWsQueueBoxServerCapturedSendInput({
            message,
            key: entry.key,
            policy,
            eligibleSessionIds: policy.admittedAudience
        }));
        expect(result.sentCount).toBe(1);
        expect(natives.get('alice')!.sent).toHaveLength(1);
        for (const id of ['bob', 'other-scope', 'unauthenticated']) {
            expect(natives.get(id)!.sent).toEqual([]);
        }
    });
});

class AccountViewBridge implements QueueBoxPubSubBridge {
    readonly published: QueueBoxPubSubMessage[] = [];
    subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1] | undefined;

    async publish(_channel: string, message: QueueBoxPubSubMessage): Promise<void> {
        this.published.push(message);
    }

    async subscribe(_channel: string, subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1]): Promise<void> {
        this.subscriber = subscriber;
    }
}
