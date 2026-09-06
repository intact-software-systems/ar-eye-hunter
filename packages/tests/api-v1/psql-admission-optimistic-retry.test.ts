import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlInboundAdmissionBackend } from '@shared-server/al-runtime/postgres/p-sql-inbound-admission-backend.ts';
import { PSqlOutboundAdmissionBackend } from '@shared-server/al-runtime/postgres/p-sql-outbound-admission-backend.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import {
    createALInboundAdmissionStore,
    createALOutboundAdmissionStore,
    InMemoryQueueBox,
    newALUnicastMessage,
    normalizeALRuntimeStoreRetention,
    planALMessageHandling,
    QueueBoxUtilities,
    type ALInboundPlanner
} from '@shared/mod.ts';

import { createPSqlAdmissionTestStorage, type PSqlAdmissionTestStorage } from '../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';
import { FakeRuntimeStateRepository } from './fake-optimistic-runtime-state-repository.ts';

describe('PSql admission optimistic retry', () => {
    it('translates an inbound apply-time CAS loss to the owner conflict result', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:apply-conflict';
        const store = createALInboundAdmissionStore({
            namespace,
            backend: new PSqlInboundAdmissionBackend(repository, namespace),
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        repository.conflictNextConditionalWrite = true;

        await expect(store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'inbound-conflict',
                senderId: 'peer-1',
                source: { kind: 'ws-client', peerId: 'peer-1' },
                supersedenceKey: null,
                expireAtTimestamp: Date.now() + 60_000
            }]
        })).resolves.toBe('conflict');
    });

    it('does not translate an unexpected inbound apply failure into a conflict', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:apply-error';
        const store = createALInboundAdmissionStore({
            namespace,
            backend: new PSqlInboundAdmissionBackend(repository, namespace),
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        repository.errorNextConditionalWrite = new Error('inbound storage unavailable');

        await expect(store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'inbound-error',
                senderId: 'peer-1',
                source: { kind: 'ws-client', peerId: 'peer-1' },
                supersedenceKey: null,
                expireAtTimestamp: Date.now() + 60_000
            }]
        })).rejects.toThrow('inbound storage unavailable');
    });

    it('requires a fresh carrier delivery after an inbound apply-time CAS loss', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:runtime-retry';
        const plan: ALInboundPlanner = (
            msg,
            source,
            observations
        ) => planALMessageHandling(msg, {
            selfPeerId: 'self',
            fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
            connectedPeerIds: ['peer-1'],
            groupMemberPeerIds: ['self', 'peer-1'],
            overlayNeighborPeerIds: [],
            ...observations
        });
        const runtime = createDefaultALInboundMessageRuntime({
            selfPeerId: 'self',
            inbox: new InMemoryQueueBox(new Map()),
            stores: {
                admissionStore: createALInboundAdmissionStore({
                    namespace: `${namespace}:inbound:admission`,
                    backend: new PSqlInboundAdmissionBackend(repository, `${namespace}:inbound:admission`),
                    orderingTrackTtlMs: 60_000,
                    supersedenceTrackTtlMs: 60_000,
                    retention: normalizeALRuntimeStoreRetention()
                })
            },
            planIncomingMessage: plan,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
            dispatchInboxEntry: () => Promise.resolve(undefined),
            sendControlMessage: () => Promise.resolve(undefined)
        });
        onTestFinished(() => runtime.dispose());
        repository.conflictNextConditionalWrite = true;
        const msg = newALUnicastMessage(
            'peer-1',
            { topicId: 'chat', resourceId: 'inbound-runtime-retry', contextId: 'chat-1' },
            'self',
            'chat.private-text.v1',
            { text: 'retry' }
        );

        const source = { kind: 'ws-client' as const, peerId: 'peer-1' };
        const conflicted = await runtime.handleIncomingMessage(msg, source);

        expect(repository.conflictCount).toBe(1);
        const admissionNamespace = `${namespace}:inbound:admission`;
        expect(conflicted.right).toEqual({ kind: 'not-admitted', reason: 'conflict' });
        expect(
            await repository.findEntry(
                admissionNamespace,
                `${admissionNamespace}:version:peer-1`
            )
        ).toBeUndefined();

        const admitted = await runtime.handleIncomingMessage(msg, source);

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(
            await repository.findEntry(
                admissionNamespace,
                `${admissionNamespace}:version:peer-1`
            )
        ).toBeDefined();
        runtime.dispose();
    });

    it('translates an outbound apply-time CAS loss to the owner conflict result', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { sql } = storage;
        const namespace = 'psql-test:outbound:apply-conflict';
        const store = createALOutboundAdmissionStore({
            namespace,
            backend: new PSqlOutboundAdmissionBackend(sql, namespace),
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        conflictNextAdmissionCommit(storage, { namespace, senderId: 'self' });

        await expect(store.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'outbound-conflict',
                senderId: 'self'
            }],
            durableEffects: []
        }, decodeALOutboundPreparedMessage)).resolves.toBe('conflict');
    });

    it('translates an outbound retry-schedule CAS loss to the owner conflict result', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { sql } = storage;
        const namespace = 'psql-test:outbound:retry-apply-conflict';
        const store = createALOutboundAdmissionStore({
            namespace,
            backend: new PSqlOutboundAdmissionBackend(sql, namespace),
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        conflictNextAdmissionCommit(storage, { namespace, senderId: 'self' });

        await expect(store.scheduleNotYetInSyncRetry({
            senderId: 'self',
            expectedVersion: undefined,
            msgId: 'outbound-retry-conflict',
            maxAttempts: 1,
            expireAtTimestamp: Date.now() + 60_000,
            createEffect: (attempt) => ({
                effectId: `nack-retry:outbound-retry-conflict:not-yet-in-sync:${attempt}`,
                expireAtTimestamp: Date.now() + 60_000,
                payload: {
                    kind: 'nack-retry',
                    msgId: 'outbound-retry-conflict',
                    reason: 'not-yet-in-sync'
                }
            })
        }, decodeALOutboundPreparedMessage)).resolves.toEqual({ status: 'conflict' });
    });

    it('does not translate an unexpected outbound apply failure into a conflict', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { sql } = storage;
        const namespace = 'psql-test:outbound:apply-error';
        const store = createALOutboundAdmissionStore({
            namespace,
            backend: new PSqlOutboundAdmissionBackend(sql, namespace),
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        vi.spyOn(sql, 'begin').mockRejectedValueOnce(new Error('outbound storage unavailable'));

        await expect(store.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'outbound-error',
                senderId: 'self'
            }],
            durableEffects: []
        }, decodeALOutboundPreparedMessage)).rejects.toThrow('outbound storage unavailable');
    });

    it('commits an outbound message after an apply-time CAS loss', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { repository } = storage;
        const namespace = 'psql-test:outbound:runtime-retry';
        const plan = () => ({ persist: true, preparedMessages: [] });
        const runtime = createDefaultALOutboundMessageRuntime({
            outbox: new InMemoryQueueBox(new Map()),
            stores: createDefaultPSqlALOutboundRuntimeStores({ namespace, repository }),
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            decodePreparedMessage: decodeALOutboundPreparedMessage,
            planOutgoingMessage: plan,
            sendPreparedMessage: async () => {
                throw new Error('An outbox-only admission must not submit a transport send');
            }
        });
        onTestFinished(() => runtime.dispose());
        conflictNextAdmissionCommit(storage, { namespace: `${namespace}:outbound:admission`, senderId: 'self' });

        const result = await runtime.enqueueIfAbsent(
            createOutboundMessage('outbound-runtime-retry')
        );

        expect(result.status).toBe('enqueued');
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

function conflictNextAdmissionCommit(
    storage: PSqlAdmissionTestStorage,
    scope: Readonly<{ namespace: string; senderId: string; }>
): void {
    const begin = storage.sql.begin;
    vi.spyOn(storage.sql, 'begin').mockImplementationOnce(async (write) => {
        await storage.repository.upsert(
            scope.namespace,
            `${scope.namespace}:version:${scope.senderId}`,
            JSON.stringify({ senderId: scope.senderId, version: 1 }),
            Date.now() + 60_000
        );
        return await begin(write);
    });
}
