import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { toDomain } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { ClientStateService, ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import { clientStateSessionStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-session-storage-key.ts';
import {
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeStateSnapshotPage } from '@shared/api/state-snapshot-page.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase, type AppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import {
    createAutoAuthorizingClientStateService,
    processAppInbox,
    requireRightSnapshot
} from './app-client-inbox-mutation-test-harness.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

interface SnapshotProducerFixture {
    readonly repository: FakeRuntimeStateRepository;
    readonly database: AppInboxTestDatabase;
    readonly service: AppClientInboxService;
    readonly reader: InboxQueueReader;
    readonly clientState: ClientStateService;
    readonly now: number;
    readonly state: {
        inTransaction: boolean;
        failCommit: boolean;
        proofSeenBeforeRollback: boolean;
        removeSessionBeforeWrite: boolean;
    };
}

interface ForeignReceiverFixture {
    readonly native: TestWebSocket;
    readonly engine: InboxOutboxEngine;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly reader: WsOutboxProvenanceReader;
    readonly socket: JsonWebSocketServer;
    readonly authentication: { scope: StateScope; now: number; };
}

describe('client snapshot producer provenance', () => {
    it('delivers the committed mutation snapshot to its frozen session on a foreign dequeue', async () => {
        const producer = createProducer();
        await seedClient(producer);
        const result = await connectClient(producer);
        expect(requireRightSnapshot(result).activeSessions.map((session) => session.sessionId)).toEqual(['alice-session']);
        const entries = [...producer.database.outboxEntries.values()].map(toStoredEntry).filter((entry) =>
            decodePersistedALMessage(entry.resource).targets?.mode === 'unicast'
        );
        expect(entries.length).toBeGreaterThan(0);
        const foreign = createForeignReceiver(producer.repository);
        for (const entry of entries) {
            await foreign.stores.workQueue.enqueue(entry);
        }
        await foreign.engine.executeOnce();
        await expect.poll(async () => (await foreign.stores.workQueue.getItem(entries[0]!.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(foreign.native.sent).toHaveLength(entries.length);
    });

    it('computes hashes before transaction entry and rolls back proof, row, receipt and state together', async () => {
        const producer = createProducer();
        await seedClient(producer);
        const before = [...producer.database.outboxEntries.keys()];
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, bytes) => {
            if (producer.state.inTransaction) {
                throw new Error('Hashing entered the write transaction');
            }
            return digest(algorithm, bytes);
        });
        onTestFinished(() => spy.mockRestore());
        producer.state.failCommit = true;
        const result = await connectClient(producer);
        expect(result.left).toBeDefined();
        expect(producer.state.proofSeenBeforeRollback).toBe(true);
        expect([...producer.database.outboxEntries.keys()]).toEqual(before);
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toEqual([]);
        expect((await producer.clientState.readSnapshot({ ...SCOPE, principalId: 'alice' }))?.activeSessions).toEqual([]);
    });

    it('creates no proof without active sessions and adds no new proof or row on command replay', async () => {
        const producer = createProducer();
        await seedClient(producer);
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toEqual([]);
        const first = await connectClient(producer);
        const proofs = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        const rows = [...producer.database.outboxEntries.keys()];
        const replay = await connectClient(producer);
        expect(requireRightSnapshot(replay)).toEqual(requireRightSnapshot(first));
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toEqual(proofs);
        expect([...producer.database.outboxEntries.keys()]).toEqual(rows);
    });

    it.each(['wrong-scope', 'replaced-session', 'expired-proof'] as const)('prevents foreign delivery for %s', async (kind) => {
        const producer = createProducer();
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        const entry = readUnicastEntries(producer)[0]!;
        const foreign = createForeignReceiver(producer.repository);
        const replacement = new TestWebSocket('ws://replacement');
        replacement.open();
        if (kind === 'wrong-scope') {
            foreign.authentication.scope = { ...SCOPE, workspaceId: 'other' };
        }
        if (kind === 'expired-proof') {
            foreign.authentication.now = entry.audit.expiryTs.epochMilliseconds;
        }
        if (kind === 'replaced-session') {
            const encode = foreign.socket.encode.bind(foreign.socket);
            const spy = vi.spyOn(foreign.socket, 'encode').mockImplementation((message) => {
                foreign.socket.addConnection(new ConnectionContext({ id: 'alice-session', socket: replacement }));
                return encode(message);
            });
            onTestFinished(() => spy.mockRestore());
        }
        await foreign.stores.workQueue.enqueue(entry);
        await foreign.engine.executeOnce();
        await expect.poll(async () => (await foreign.stores.workQueue.getItem(entry.key))?.status)
            .toBe(kind === 'expired-proof' ? EntityStatus.NON_RETRYABLE : EntityStatus.COMPLETED);
        expect(foreign.native.sent).toEqual([]);
        expect(replacement.sent).toEqual([]);
    });

    it('binds every snapshot page and never admits a late local session', async () => {
        const producer = createProducer();
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        const before = new Set(producer.database.outboxEntries.keys());
        requireRightSnapshot(
            await processAppInbox(producer.service, producer.reader, {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                senderId: 'alice',
                data: {
                    scope: SCOPE,
                    principalId: 'alice',
                    request: { username: 'alice', actorPrincipalId: 'alice', metadata: { description: 'x'.repeat(52_000) }, requestId: 'large-profile' }
                }
            })
        );
        const pages = [...producer.database.outboxEntries].filter(([key]) => !before.has(key))
            .map(([, entry]) => toStoredEntry(entry)).filter((entry) => decodePersistedALMessage(entry.resource).targets?.mode === 'unicast');
        expect(pages.length).toBeGreaterThan(1);
        const foreign = createForeignReceiver(producer.repository);
        const late = new TestWebSocket('ws://late');
        late.open();
        foreign.socket.addConnection(new ConnectionContext({ id: 'late-session', socket: late }));
        const indexes: number[] = [];
        for (const entry of pages) {
            const message = decodePersistedALMessage(entry.resource);
            const page = decodeStateSnapshotPage(message, SCOPE).fold((issue) => {
                throw new Error(issue.message);
            }, (value) => value);
            indexes.push(page.index);
            expect(page.count).toBe(pages.length);
            expect(await foreign.reader.readProducerProvenance(message, entry)).toEqual({ admittedAudience: ['alice-session'], recipientScope: SCOPE });
            await foreign.stores.workQueue.enqueue(entry);
        }
        expect(indexes).toEqual(Array.from({ length: pages.length }, (_, index) => index));
        await foreign.engine.executeOnce();
        await expect.poll(() => foreign.native.sent.length).toBe(pages.length);
        expect(late.sent).toEqual([]);
    });

    it('keeps the accepted audience when durable session state changes between read and write', async () => {
        const producer = createProducer();
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        const before = new Set(producer.database.outboxEntries.keys());
        producer.state.removeSessionBeforeWrite = true;
        const result = await processAppInbox(producer.service, producer.reader, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: { username: 'alice', displayName: 'Frozen observation', actorPrincipalId: 'alice', requestId: 'interval-profile' }
            }
        });
        expect(requireRightSnapshot(result).activeSessions.map((session) => session.sessionId)).toEqual(['alice-session']);
        expect((await producer.clientState.readSnapshot({ ...SCOPE, principalId: 'alice' }))?.activeSessions).toEqual([]);
        const entry = [...producer.database.outboxEntries].filter(([key]) => !before.has(key)).map(([, row]) => toStoredEntry(row))
            .find((row) => decodePersistedALMessage(row.resource).targets?.mode === 'unicast')!;
        const foreign = createForeignReceiver(producer.repository);
        await foreign.stores.workQueue.enqueue(entry);
        await foreign.engine.executeOnce();
        await expect.poll(() => foreign.native.sent.length).toBe(1);
    });
});

function readUnicastEntries(producer: SnapshotProducerFixture): ResourceEntry[] {
    return [...producer.database.outboxEntries.values()].map(toStoredEntry)
        .filter((entry) => decodePersistedALMessage(entry.resource).targets?.mode === 'unicast');
}

function toStoredEntry(entry: ResourceEntry): ResourceEntry {
    return toDomain({
        ri_row_id: 1n,
        ri_resource_id: entry.key.resourceId,
        ri_topic_id: entry.key.topicId,
        ri_resource: entry.resource,
        ri_type_id: entry.typeId,
        ri_status: entry.status,
        fk_ext_bank_id: entry.key.contextId,
        system_date: entry.audit.createdTs.toPlainDate().toString(),
        created_by: entry.audit.createdBy,
        created_ts: entry.audit.createdTs.toString(),
        expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
        start_ts: null,
        end_ts: null,
        next_ts: null,
        ri_attempts: 0n
    });
}

function createProducer(): SnapshotProducerFixture {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    const reader = new InboxQueueReader(queue);
    const repository = new FakeRuntimeStateRepository();
    const state = { inTransaction: false, failCommit: false, proofSeenBeforeRollback: false, removeSessionBeforeWrite: false };
    const database = createAppInboxTestDatabase(queue, results, {
        runtimeRepository: repository,
        withTransaction: async (write) => {
            if (state.removeSessionBeforeWrite) {
                await repository.deleteByKey(
                    CLIENT_STATE_SESSIONS_NAMESPACE,
                    clientStateSessionStorageKey({
                        ...SCOPE,
                        principalId: 'alice',
                        clientInstanceId: 'browser',
                        sessionId: 'alice-session'
                    })
                );
            }
            state.inTransaction = true;
            try {
                return await write();
            }
            finally {
                state.inTransaction = false;
            }
        },
        onStage: async (stage) => {
            if (state.failCommit && stage === 'transaction-commit-return') {
                state.failCommit = false;
                state.proofSeenBeforeRollback = (await repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).length > 0;
                throw new NonRetryableException('Injected commit failure');
            }
        }
    });
    const clientState = createAutoAuthorizingClientStateService(repository, database);
    const service = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: queue,
        resourceInboxResultsRepository: results,
        database,
        clientStateService: clientState
    }, { serviceId: 'producer-server' });
    return { repository, database, service, reader, state, clientState, now: Date.now() };
}

async function seedClient(producer: SnapshotProducerFixture): Promise<void> {
    const principal = await processAppInbox(producer.service, producer.reader, {
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        senderId: 'alice',
        data: { scope: SCOPE, principalId: 'alice', request: { username: 'alice', actorPrincipalId: 'alice', requestId: 'principal' } }
    });
    requireRightSnapshot(principal);
    const instance = await processAppInbox(producer.service, producer.reader, {
        type: AppInboxType.CLIENT_INSTANCE_UPSERT,
        senderId: 'alice',
        data: {
            scope: SCOPE,
            principalId: 'alice',
            clientInstanceId: 'browser',
            request: { platform: 'web', capabilities: ['ws'], actorPrincipalId: 'alice', requestId: 'instance' }
        }
    });
    requireRightSnapshot(instance);
}

function connectClient(producer: SnapshotProducerFixture): Promise<Either<AppInboxFailure, ClientStateWritten>> {
    const now = producer.now;
    return processAppInbox(producer.service, producer.reader, {
        type: AppInboxType.CLIENT_SESSION_CONNECT,
        senderId: 'alice',
        data: {
            scope: SCOPE,
            principalId: 'alice',
            clientInstanceId: 'browser',
            sessionId: 'alice-session',
            request: {
                generationId: 'generation',
                presenceState: 'online',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                connectedAtEpochMs: now,
                lastHeartbeatAtEpochMs: now,
                expiresAtEpochMs: now + 60_000,
                requestId: 'connect'
            }
        }
    });
}

function createForeignReceiver(repository: FakeRuntimeStateRepository): ForeignReceiverFixture {
    const authentication = { scope: SCOPE, now: Date.now() };
    const reader = new WsOutboxProvenanceReader({ repository, nowMs: () => authentication.now });
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://foreign');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'alice-session', socket: native }));
    const engine = new InboxOutboxEngine();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const service = createDefaultWsQueueBoxServerService({
        name: 'foreign-server',
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        readProducerProvenance: (message, entry) => reader.readProducerProvenance(message, entry),
        readAuthenticatedConnectionScope: () => ({ scope: authentication.scope, expiresAtEpochMs: Date.now() + 60_000 })
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
    });
    return { native, engine, stores, reader, socket, authentication };
}
