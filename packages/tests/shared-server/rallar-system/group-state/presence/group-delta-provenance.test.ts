import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { PRESENCE_SUMMARIES_NAMESPACE, SESSIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { decodeCanonicalGroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/decode-canonical-group-presence-summary-work.ts';
import {
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { createGroupDeltaProducer, type GroupDeltaProducerFixture } from './group-delta-producer-fixture.ts';

interface GroupDeltaReceiverFixture {
    readonly reader: WsOutboxProvenanceReader;
    readonly socket: JsonWebSocketServer;
    readonly native: TestWebSocket;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly engine: InboxOutboxEngine;
    readonly authentication: { scope: StateScope; now: number; };
}

describe('group presence delta producer provenance', () => {
    it('delivers a real committed presence-summary delta on a foreign API dequeue', async () => {
        const producer = await createGroupDeltaProducer();
        await producer.worker.processReservedEntry(producer.message, producer.entry);
        const rows = await producer.database<ResourceInboxRow[]>`select * from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX}`;
        expect(rows).toHaveLength(1);
        const entry = toDomain(rows[0]!);
        const receiver = createGroupDeltaReceiver(producer);
        await receiver.stores.workQueue.enqueue(entry);
        await receiver.engine.executeOnce();
        await expect.poll(async () => (await receiver.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(receiver.native.sent).toHaveLength(1);
    });

    it('rolls back row, proof and summary on commit failure, and hashes before entry', async () => {
        const producer = await createGroupDeltaProducer();
        const before = await producer.repository.findAllEntries(PRESENCE_SUMMARIES_NAMESPACE);
        let inTransaction = false;
        let proofWritten = false;
        const begin = producer.database.begin.bind(producer.database);
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const hash = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, bytes) => {
            expect(inTransaction).toBe(false);
            return digest(algorithm, bytes);
        });
        const transaction = vi.spyOn(producer.database, 'begin').mockImplementation(async (write) =>
            await begin(async (sql) => {
                inTransaction = true;
                try {
                    await write(sql);
                    proofWritten =
                        (await sql<
                            { store_key: string; }[]
                        >`select store_key from runtime_state_store where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE}`).length === 1;
                    throw new Error('Injected commit failure');
                }
                finally {
                    inTransaction = false;
                }
            })
        );
        onTestFinished(() => {
            hash.mockRestore();
            transaction.mockRestore();
        });
        await expect(producer.worker.processReservedEntry(producer.message, producer.entry)).rejects.toThrow('Injected commit failure');
        expect(proofWritten).toBe(true);
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toEqual([]);
        expect(await producer.repository.findAllEntries(PRESENCE_SUMMARIES_NAMESPACE)).toEqual(before);
        expect(await producer.database`select * from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX}`).toEqual([]);
    });

    it.each(['reservation', 'proof-collision'] as const)('rolls back all new writes on %s conflict', async (kind) => {
        const producer = await createGroupDeltaProducer();
        const before = await producer.repository.findAllEntries(PRESENCE_SUMMARIES_NAMESPACE);
        if (kind === 'reservation') {
            await producer.database`update resource_inbox set ri_attempts = ri_attempts + 1 where ri_resource_id = ${producer.entry.key.resourceId}`;
        }
        else {
            const work = decodeCanonicalGroupPresenceSummaryWork(producer.message, producer.entry);
            const read = await producer.worker.read(work, { key: producer.entry.key, expectedAttempts: 1 }, producer.now);
            const row = producer.worker.compute(work, read).downstreamOutboxWrites[0]!.entry;
            await producer.repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, toWsOutboxProvenanceKey(row.key), 'existing-proof', producer.now + 60_000);
        }
        await expect(producer.worker.processReservedEntry(producer.message, producer.entry)).rejects.toBeDefined();
        expect(await producer.repository.findAllEntries(PRESENCE_SUMMARIES_NAMESPACE)).toEqual(before);
        expect(await producer.database`select * from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX}`).toEqual([]);
        const proofs = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        expect(proofs.map((proof) => proof.value)).toEqual(kind === 'proof-collision' ? ['existing-proof'] : []);
    });

    it('proves a no-op summary delta and refuses duplicate reservation replay without additional rows', async () => {
        const producer = await createGroupDeltaProducer();
        await producer.worker.processReservedEntry(producer.message, producer.entry);
        const before = await producer.repository.findAllEntries(PRESENCE_SUMMARIES_NAMESPACE);
        const original = producer.worker.compute;
        const computed = vi.spyOn(producer.worker, 'compute').mockImplementation(function (work, read) {
            const result = original.call(producer.worker, work, read);
            expect(result.summaryWrite).toBeNull();
            expect(result.downstreamOutboxWrites).toHaveLength(1);
            return result;
        });
        const queued = computeGroupPresenceSummaryEntry({
            ...decodeCanonicalGroupPresenceSummaryWork(producer.message, producer.entry),
            commandId: 'second-summary'
        }, 'producer-api');
        const second = { ...queued, status: EntityStatus.RESERVED, dequeueAudit: producer.entry.dequeueAudit };
        await producer.resources.entries.write(second);
        await producer.worker.processReservedEntry(decodePersistedALMessage(second.resource), second);
        expect(await producer.repository.findAllEntries(PRESENCE_SUMMARIES_NAMESPACE)).toEqual(before);
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toHaveLength(2);
        await expect(producer.worker.processReservedEntry(decodePersistedALMessage(second.resource), second)).rejects.toBeDefined();
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toHaveLength(2);
        expect(await producer.database`select * from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX}`).toHaveLength(2);
        computed.mockRestore();
    });

    it.each(['late-join', 'replaced-session', 'wrong-scope', 'expired', 'audit-tampering', 'wrong-room', 'no-audience'] as const)(
        'enforces %s on a real proved producer row',
        async (kind) => {
            const producer = await createGroupDeltaProducer();
            if (kind === 'no-audience') {
                for (const session of await producer.repository.findAllEntries(SESSIONS_NAMESPACE)) {
                    await producer.repository.deleteByKey(SESSIONS_NAMESPACE, session.key);
                }
            }
            await producer.worker.processReservedEntry(producer.message, producer.entry);
            const rows = await producer.database<ResourceInboxRow[]>`select * from resource_inbox where ri_type_id = ${EnqueuedType.WS_OUTBOX}`;
            const entry = toDomain(rows[0]!);
            const receiver = createGroupDeltaReceiver(producer);
            const late = new TestWebSocket('ws://late');
            late.open();
            receiver.socket.addConnection(new ConnectionContext({ id: 'late-session', socket: late }));
            if (kind === 'wrong-scope') {
                receiver.authentication.scope = { ...producer.ref, workspaceId: 'other' };
            }
            if (kind === 'expired') {
                receiver.authentication.now = entry.audit.expiryTs.epochMilliseconds;
            }
            if (kind === 'replaced-session') {
                const encode = receiver.socket.encode.bind(receiver.socket);
                const spy = vi.spyOn(receiver.socket, 'encode').mockImplementation((message) => {
                    receiver.socket.addConnection(new ConnectionContext({ id: 'session-alice', socket: late }));
                    return encode(message);
                });
                onTestFinished(() => spy.mockRestore());
            }
            if (kind === 'wrong-room') {
                const key = toWsOutboxProvenanceKey(entry.key);
                const stored = (await producer.repository.findEntry(WS_OUTBOX_PROVENANCE_NAMESPACE, key))!;
                const proof = JSON.parse(stored.value);
                proof.target.groupRef.groupId = 'other';
                await producer.repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, key, JSON.stringify(proof), stored.expireAtTimestamp);
            }
            await receiver.stores.workQueue.enqueue(kind === 'audit-tampering' ? { ...entry, audit: { ...entry.audit, createdBy: 'forged' } } : entry);
            await receiver.engine.executeOnce();
            const corrupt = ['expired', 'audit-tampering', 'wrong-room'].includes(kind);
            await expect.poll(async () => (await receiver.stores.workQueue.getItem(entry.key))?.status).toBe(
                corrupt ? EntityStatus.NON_RETRYABLE : EntityStatus.COMPLETED
            );
            expect(receiver.native.sent).toHaveLength(kind === 'late-join' ? 1 : 0);
            expect(late.sent).toEqual([]);
        }
    );
});

function createGroupDeltaReceiver(producer: GroupDeltaProducerFixture): GroupDeltaReceiverFixture {
    const authentication: { scope: StateScope; now: number; } = { scope: producer.ref, now: producer.now };
    const reader = new WsOutboxProvenanceReader({ repository: producer.repository, nowMs: () => authentication.now });
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://foreign-api');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'session-alice', socket: native }));
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        name: 'foreign-api',
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        readProducerProvenance: (message, entry) => reader.readProducerProvenance(message, entry),
        readAuthenticatedConnectionScope: () => ({ scope: authentication.scope, expiresAtEpochMs: producer.now + 60_000 })
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
    });
    return { reader, socket, native, stores, engine, authentication };
}
