import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundAdmissionRead, ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { decodeALInboundWorkEntry, toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import type { ALOutboundMessageRuntime, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundWorkEntry, toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import {
    createALInboundAdmissionStore,
    createALOutboundAdmissionStore,
    newALUnicastMessage,
    normalizeALRuntimeStoreRetention,
    planALMessageHandling,
    QueueBoxUtilities
} from '@shared/mod.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage, type PSqlAdmissionTestStorage } from '../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

describe('PSql admission optimistic retry', () => {
    it('translates an inbound apply-time CAS loss to the owner conflict result', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { sql } = storage;
        const namespace = 'psql-test:inbound:apply-conflict';
        const store = createALInboundAdmissionStore({
            nowMs: Date.now,
            namespace,
            backend: new PSqlAdmissionWorkBackend(sql, namespace),
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const message = createInboundMessage('inbound-conflict');
        conflictNextInboundCommit({ storage, namespace, msg: message, nowMs: Date.now });

        await expect(store.commitMutations({
            senderId: 'peer-1',
            observations: (await readIncoming(store, message, Date.now())).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: 'inbound-conflict',
                    senderId: 'peer-1',
                    source: { kind: 'ws-client', peerId: 'peer-1' },
                    supersedenceKey: null
                },
                expireAtTimestamp: Date.now() + 60_000
            }]
        })).resolves.toBe('conflict');
    });

    it('does not translate an unexpected inbound apply failure into a conflict', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { sql } = storage;
        const namespace = 'psql-test:inbound:apply-error';
        const store = createALInboundAdmissionStore({
            nowMs: Date.now,
            namespace,
            backend: new PSqlAdmissionWorkBackend(sql, namespace),
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const message = createInboundMessage('inbound-error');
        vi.spyOn(sql, 'begin').mockRejectedValueOnce(new Error('inbound storage unavailable'));

        await expect(store.commitMutations({
            senderId: 'peer-1',
            observations: (await readIncoming(store, message, Date.now())).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: 'inbound-error',
                    senderId: 'peer-1',
                    source: { kind: 'ws-client', peerId: 'peer-1' },
                    supersedenceKey: null
                },
                expireAtTimestamp: Date.now() + 60_000
            }]
        })).rejects.toThrow('inbound storage unavailable');
    });

    it('retains an inbound apply-time CAS loss for fresh admission after restart', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const namespace = 'psql-test:inbound:runtime-retry';
        const options = { namespace, repository: storage.repository };
        const stores = createDefaultPSqlALInboundRuntimeStores(options);
        const store = stores.admissionStore;
        const deliveredMessageIds: string[] = [];
        const controls: ALMessage[] = [];
        const runtime = createInboundTestRuntime(stores, deliveredMessageIds, controls);
        await runtime.ready();
        const retain = stores.workQueue.enqueueIfAbsent.bind(stores.workQueue);
        const retention = vi.spyOn(stores.workQueue, 'enqueueIfAbsent').mockImplementationOnce(async (entry) => {
            const observed = await retain(entry);
            runtime.dispose(); // Stop after durable retention, before its first worker claim.
            return observed;
        });
        const msg = createInboundMessage('inbound-runtime-retry');
        conflictNextInboundCommit({ storage, namespace: store.namespace, msg, nowMs: Date.now });
        const source = { kind: 'ws-client' as const, peerId: 'peer-1' };

        const conflicted = await runtime.admitIncomingMessage(msg, source);

        expect(conflicted.right).toEqual({ kind: 'pending-admission' });
        expect(deliveredMessageIds).toEqual([]);
        expect(controls).toEqual([]);
        expect((await readIncoming(store, msg, Date.now())).dedupExpiresAt).toBeUndefined();
        const page = await stores.workQueue.readWorkPage({
            typeId: toALInboundWorkType(store.namespace),
            status: EntityStatus.NEW,
            maxToRead: 2,
            cursor: null
        });
        expect(page.entries).toHaveLength(1);
        const pending = decodeALInboundWorkEntry(page.entries[0], store.namespace);
        expect(pending.payload).toMatchObject({ kind: 'admit-message', msg: { id: msg.id }, source });
        expect(pending.expireAtTimestamp).toBe(msg.constraints?.expiresAtMs);
        retention.mockRestore();

        const restartedStores = createDefaultPSqlALInboundRuntimeStores(options);
        const restartedStore = restartedStores.admissionStore;
        const restarted = createInboundTestRuntime(restartedStores, deliveredMessageIds, controls);
        await restarted.ready();
        await expect.poll(() => deliveredMessageIds).toEqual([msg.id.msgId]);
        expect((await readIncoming(restartedStore, msg, Date.now())).dedupExpiresAt).toBeGreaterThan(Date.now());
        expect((await restarted.admitIncomingMessage(msg, source)).right).toEqual({ kind: 'duplicate' });
        expect(deliveredMessageIds).toEqual([msg.id.msgId]);
    });

    it('translates an outbound apply-time CAS loss to the owner conflict result', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { sql } = storage;
        const namespace = 'psql-test:outbound:apply-conflict';
        const backend = new PSqlAdmissionWorkBackend(sql, namespace);
        const store = createALOutboundAdmissionStore({
            decodePrepared: decodeALOutboundTransportMessage,
            nowMs: Date.now,
            namespace,
            canonicalScope: namespace,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        conflictNextAdmissionCommit(storage, { namespace, senderId: 'self' }, Date.now);

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

    it('translates an outbound retry-schedule CAS loss to the owner conflict result', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { sql } = storage;
        const namespace = 'psql-test:outbound:retry-apply-conflict';
        const backend = new PSqlAdmissionWorkBackend(sql, namespace);
        const store = createALOutboundAdmissionStore({
            decodePrepared: decodeALOutboundTransportMessage,
            nowMs: Date.now,
            namespace,
            canonicalScope: namespace,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        conflictNextAdmissionCommit(storage, { namespace, senderId: 'self' }, Date.now);

        const control = createTestALOutboundControlAdmission({
            admissionStore: store,
            workQueue: backend.workQueue,
            nowMs: Date.now
        });

        await expect(control.scheduleNotYetInSyncRetry({
            senderId: 'self',
            expectedVersion: undefined,
            msgId: 'outbound-retry-conflict',
            maxAttempts: 1,
            expireAtTimestamp: Date.now() + 60_000,
            retryAtMs: Date.now()
        })).resolves.toEqual({ status: 'conflict' });
    });

    it('does not translate an unexpected outbound apply failure into a conflict', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { sql } = storage;
        const namespace = 'psql-test:outbound:apply-error';
        const store = createALOutboundAdmissionStore({
            decodePrepared: decodeALOutboundTransportMessage,
            nowMs: Date.now,
            namespace,
            canonicalScope: namespace,
            backend: new PSqlAdmissionWorkBackend(sql, namespace),
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
        })).rejects.toThrow('outbound storage unavailable');
    });

    it('retains a post-read outbound conflict and activates its canonical row after restart', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { repository } = storage;
        const options = {
            namespace: 'psql-test:outbound:runtime-conflict',
            repository,
            decodePrepared: decodeALOutboundPreparedMessage
        };
        const stores = createDefaultPSqlALOutboundRuntimeStores(options);
        const store = stores.admissionStore;
        const runtime = createOutboxOnlyTestRuntime(stores);
        await runtime.ready();
        const commit = store.commitBundle.bind(store);
        vi.spyOn(store, 'commitBundle').mockImplementationOnce(async (candidate) => {
            expect(candidate.expectedVersion).toBeUndefined();
            await repository.upsert(
                store.namespace,
                `${store.namespace}:version:self`,
                JSON.stringify({ senderId: 'self', version: 1 }),
                Date.now() + 60_000
            );
            return await commit(candidate);
        });
        const retain = store.retainPendingAdmission.bind(store);
        vi.spyOn(store, 'retainPendingAdmission').mockImplementationOnce(async (input) => {
            const status = await retain(input);
            runtime.dispose(); // Retention owns the message; admission has not activated physical work.
            return status;
        });
        const message = createOutboundMessage('outbound-runtime-conflict');

        const result = await runtime.enqueueIfAbsent(message);

        expect(result).toMatchObject({ status: 'pending-admission', message });
        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        const canonical = await stores.workQueue.getItem(result.entries[0].key);
        expect(canonical?.status).toBe(EntityStatus.COMPLETED);
        expect(decodePersistedALMessage(canonical!.resource)).toEqual(JSON.parse(JSON.stringify(message)));
        const page = await stores.workQueue.readWorkPage({
            typeId: toALOutboundWorkType(store.namespace),
            status: EntityStatus.NEW,
            maxToRead: 2,
            cursor: null
        });
        expect(page.entries).toHaveLength(1);
        const pending = decodeALOutboundWorkEntry(page.entries[0], store.namespace, { message, decodePrepared: decodeALOutboundPreparedMessage });
        expect(pending.payload).toMatchObject({ kind: 'admit-message', preparedMessages: [] });
        expect(pending.expireAtTimestamp).toBe(message.constraints?.expiresAtMs);

        const restartedStores = createDefaultPSqlALOutboundRuntimeStores(options);
        const restarted = createOutboxOnlyTestRuntime(restartedStores);
        await restarted.ready();
        await expect.poll(() => restartedStores.admissionStore.readSentMessage(message.id.msgId)).toMatchObject({ msg: JSON.parse(JSON.stringify(message)) });
        const activated = await restartedStores.workQueue.getItem(canonical!.key);
        expect(activated?.status).toBe(EntityStatus.NEW);
        expect((await restarted.enqueueIfAbsent(message)).status).toBe('duplicate');
        expect(await restartedStores.workQueue.getItem(canonical!.key)).toEqual(activated);
    });
});

function createInboundTestRuntime(
    stores: ALInboundRuntimeStores,
    deliveredMessageIds: string[],
    controls: ALMessage[]
): ALInboundMessageRuntime {
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'self',
        stores,
        planIncomingMessage: (msg, source, observations) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                connectedPeerIds: ['peer-1'],
                groupMemberPeerIds: ['self', 'peer-1'],
                overlayNeighborPeerIds: [],
                ...observations
            }),
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
        dispatchInboxEntry: async (entry) => {
            deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        sendControlMessage: async (msg) => {
            controls.push(msg);
        },
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

function createOutboxOnlyTestRuntime(
    stores: ALOutboundRuntimeStores<ALMessage>
): ALOutboundMessageRuntime<ALMessage> {
    const runtime = createDefaultALOutboundMessageRuntime({
        outbox: stores.workQueue,
        stores,
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        decodePreparedMessage: decodeALOutboundPreparedMessage,
        planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [] }),
        sendPreparedMessage: async () => {
            throw new Error('An outbox-only admission must not submit a transport send');
        }
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

function createOutboundMessage(resourceId: string): ALMessage {
    return newALUnicastMessage(
        'self',
        { topicId: 'chat', resourceId, contextId: 'chat-1' },
        'peer-1',
        'chat.private-text.v1',
        { text: 'hello' },
        { ttlMs: 30_000 }
    );
}

function conflictNextAdmissionCommit(
    storage: PSqlAdmissionTestStorage,
    scope: Readonly<{ namespace: string; senderId: string; }>,
    nowMs: () => number
): void {
    const begin = storage.sql.begin;
    vi.spyOn(storage.sql, 'begin').mockImplementationOnce(async (write) => {
        await storage.repository.upsert(
            scope.namespace,
            `${scope.namespace}:version:${scope.senderId}`,
            JSON.stringify({ senderId: scope.senderId, version: 1 }),
            nowMs() + 60_000
        );
        return await begin(write);
    });
}

function createInboundMessage(msgId: string): ALMessage {
    const original = newALUnicastMessage(
        'peer-1',
        { topicId: 'chat', resourceId: msgId, contextId: 'chat-1' },
        'self',
        'chat.private-text.v1',
        { text: 'retry' },
        { ttlMs: 30_000 }
    );
    return { ...original, id: { ...original.id, msgId } };
}

async function readIncoming(store: ALInboundAdmissionStore, msg: ALMessage, nowMs: number): Promise<ALInboundAdmissionRead> {
    return await store.readIncomingMessage({
        msg,
        source: { kind: 'ws-client', peerId: msg.id.senderId },
        nowMs,
        prePlan: planALMessageHandling(msg, { selfPeerId: 'self', nowMs })
    });
}

interface ConflictingInboundCommitInput {
    readonly storage: PSqlAdmissionTestStorage;
    readonly namespace: string;
    readonly msg: ALMessage;
    readonly nowMs: () => number;
}

function conflictNextInboundCommit({ storage, namespace, msg, nowMs }: ConflictingInboundCommitInput): void {
    const begin = storage.sql.begin;
    vi.spyOn(storage.sql, 'begin').mockImplementationOnce(async (write) => {
        await storage.repository.upsert(
            namespace,
            `${namespace}:msg-owner:${encodeURIComponent(msg.id.msgId)}:${encodeURIComponent(msg.id.senderId)}`,
            JSON.stringify({
                msgId: msg.id.msgId,
                senderId: msg.id.senderId,
                source: { kind: 'ws-client', peerId: msg.id.senderId },
                supersedenceKey: null
            }),
            nowMs() + 60_000
        );
        return await begin(write);
    });
}
