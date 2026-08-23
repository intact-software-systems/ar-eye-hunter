import { createPSqlALInboundRuntimeStores, createPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlInboundAdmissionBackend } from '@shared-server/al-runtime/postgres/p-sql-inbound-admission-backend.ts';
import { PSqlOutboundAdmissionBackend } from '@shared-server/al-runtime/postgres/p-sql-outbound-admission-backend.ts';
import {
    ALInboundMessageRuntime,
    ALOutboundMessageRuntime,
    type ALInboundMessageRuntimeInput,
    createALInboundAdmissionStore,
    createALOutboundAdmissionStore,
    InMemoryQueueBox,
    newALUnicastMessage,
    planALMessageHandling,
    QueueBoxUtilities
} from '@shared/mod.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from './fake-optimistic-runtime-state-repository.ts';

describe('PSql admission optimistic retry', () => {
    it('translates an inbound apply-time CAS loss to the owner conflict result', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:apply-conflict';
        const store = createALInboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlInboundAdmissionBackend(repository, namespace),
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000
        });
        repository.conflictNextConditionalWrite = true;

        await expect(store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'inbound-conflict',
                senderId: 'peer-1'
            }]
        })).resolves.toBe('conflict');
    });

    it('does not translate an unexpected inbound apply failure into a conflict', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:apply-error';
        const store = createALInboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlInboundAdmissionBackend(repository, namespace),
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000
        });
        repository.errorNextConditionalWrite = new Error('inbound storage unavailable');

        await expect(store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'inbound-error',
                senderId: 'peer-1'
            }]
        })).rejects.toThrow('inbound storage unavailable');
    });

    it('commits an inbound message after an apply-time CAS loss', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:runtime-retry';
        const plan: ALInboundMessageRuntimeInput['planIncomingMessage'] = (
            msg,
            fromPeerId,
            stores
        ) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId,
                connectedPeerIds: ['peer-1'],
                groupMemberPeerIds: ['self', 'peer-1'],
                overlayNeighborPeerIds: [],
                dedupStore: stores.dedupStore,
                orderingStore: stores.orderingStore,
                supersedenceStore: stores.supersedenceStore
            });
        const runtime = new ALInboundMessageRuntime({
            selfPeerId: 'self',
            inbox: new InMemoryQueueBox(new Map()),
            stores: createPSqlALInboundRuntimeStores({ namespace, repository }),
            planIncomingMessage: plan,
            readStoredEntry: (entry) => JSON.parse(entry.resource),
            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
            dispatchInboxEntry: () => Promise.resolve(undefined),
            sendControlMessage: () => Promise.resolve(undefined)
        });
        repository.conflictNextConditionalWrite = true;
        const msg = newALUnicastMessage(
            'peer-1',
            { topicId: 'chat', resourceId: 'inbound-runtime-retry', contextId: 'chat-1' },
            'self',
            'chat.private-text.v1',
            { text: 'retry' }
        );

        await runtime.handleIncomingMessage(msg, 'peer-1');

        expect(repository.conflictCount).toBe(1);
        const admissionNamespace = `${namespace}:inbound:admission`;
        expect(
            await repository.findEntry(
                admissionNamespace,
                `${admissionNamespace}:version:peer-1`
            )
        ).toBeDefined();
        runtime.dispose();
    });

    it('translates an outbound apply-time CAS loss to the owner conflict result', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:outbound:apply-conflict';
        const store = createALOutboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlOutboundAdmissionBackend(repository, namespace),
            supersedenceTrackTtlMs: 60_000
        });
        repository.conflictNextConditionalWrite = true;

        await expect(store.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'outbound-conflict',
                senderId: 'self'
            }],
            durableEffects: []
        })).resolves.toBe('conflict');
    });

    it('does not translate an unexpected outbound apply failure into a conflict', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:outbound:apply-error';
        const store = createALOutboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlOutboundAdmissionBackend(repository, namespace),
            supersedenceTrackTtlMs: 60_000
        });
        repository.errorNextConditionalWrite = new Error('outbound storage unavailable');

        await expect(store.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'outbound-error',
                senderId: 'self'
            }],
            durableEffects: []
        })).rejects.toThrow('outbound storage unavailable');
    });

    it('commits an outbound message after an apply-time CAS loss', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:outbound:runtime-retry';
        const plan = () => ({ persist: true, preparedMessages: [] });
        const runtime = new ALOutboundMessageRuntime({
            outbox: new InMemoryQueueBox(new Map()),
            stores: createPSqlALOutboundRuntimeStores({ namespace, repository }),
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
            readMessageFromEntry: (entry) => JSON.parse(entry.resource),
            planOutgoingMessage: plan,
            sendPreparedMessage: () => Promise.resolve(undefined)
        });
        repository.conflictNextConditionalWrite = true;

        const result = await runtime.enqueueIfAbsent(
            createOutboundMessage('outbound-runtime-retry')
        );

        expect(result.status).toBe('enqueued');
        expect(repository.conflictCount).toBe(1);
        const admissionNamespace = `${namespace}:outbound:admission`;
        expect(
            await repository.findEntry(
                admissionNamespace,
                `${admissionNamespace}:version:self`
            )
        ).toBeDefined();
        runtime.dispose();
    });
});

function createOutboundMessage(resourceId: string) {
    return newALUnicastMessage(
        'self',
        { topicId: 'chat', resourceId, contextId: 'chat-1' },
        'peer-1',
        'chat.private-text.v1',
        { text: 'hello' }
    );
}
