import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { installQueueBoxPubSubBridge, toPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import {
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createAuthInboxTestRuntime,
    runAuthInboxCommand,
    type AuthInboxTestRuntime
} from './auth-app-inbox-test-runtime.ts';

interface LogoutDeliveryFixture {
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly reader: WsOutboxProvenanceReader;
    readonly engine: InboxOutboxEngine;
    readonly bridge: RecordingBridge;
    readonly remoteBridge: RecordingBridge;
    readonly remoteSocket: JsonWebSocketServer;
    readonly target: TestWebSocket;
    readonly outsider: TestWebSocket;
}

interface LogoutFixture extends LogoutDeliveryFixture {
    readonly auth: AuthInboxTestRuntime;
    readonly repository: FakeRuntimeStateRepository;
    readonly failure: { failCommit: boolean; proofSeen: boolean; inTransaction: boolean; };
    readonly session: IssuedAuthSession;
    readonly sessions: AuthSessionRepository;
    readonly logout: () => Promise<ResourceEntry>;
}

describe('auth logout exact-session cluster delivery', () => {
    it.each([false, true])('uses the exact prepared session and fences local replacement=%s', async (replace) => {
        const fixture = await createFixture(false);
        const entry = await fixture.logout();
        const replacement = new TestWebSocket('ws://replacement');
        replacement.open();
        if (replace) {
            const encode = fixture.remoteSocket.encode.bind(fixture.remoteSocket);
            vi.spyOn(fixture.remoteSocket, 'encode').mockImplementation((message) => {
                fixture.remoteSocket.addConnection(new ConnectionContext({ id: fixture.session.sessionId, socket: replacement }));
                return encode(message);
            });
        }
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe('COMPLETED');
        expect(await fixture.stores.admissionStore.hasSentMessageAdmission(decodePersistedALMessage(entry.resource).id.msgId)).toBe(true);
        expect(fixture.target.sent).toHaveLength(replace ? 0 : 1);
        expect(replacement.sent).toEqual([]);
        expect(fixture.outsider.sent).toEqual([]);
    });
    it('delivers the committed invalidation from A to only its session on B', async () => {
        const fixture = await createFixture();
        const entry = await fixture.logout();
        expect(await fixture.reader.readProducerProvenance(decodePersistedALMessage(entry.resource), entry)).toMatchObject({
            sessionInvalidation: { sessionId: fixture.session.sessionId }
        });
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(() => fixture.bridge.published.length).toBe(1);
        await fixture.remoteBridge.subscriber?.(toPubSubMessage({ channel: 'events', publisherId: 'A', entry }));
        expect(fixture.target.sent).toHaveLength(1);
        expect(fixture.outsider.sent).toEqual([]);
        expect(await fixture.sessions.findBySessionId(fixture.session.sessionId)).toBeUndefined();
        for (const result of fixture.auth.results.allEntries()) {
            expect(result.audit.date.toString()).toBe(result.audit.createdTs.toPlainTime().toString());
        }
    });

    it('refuses a replacement generation with the same session ID during native encoding', async () => {
        const fixture = await createFixture();
        const entry = await fixture.logout();
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(() => fixture.bridge.published.length).toBe(1);
        const replacement = new TestWebSocket('ws://replacement');
        replacement.open();
        const encode = fixture.remoteSocket.encode.bind(fixture.remoteSocket);
        vi.spyOn(fixture.remoteSocket, 'encode').mockImplementation((message) => {
            fixture.remoteSocket.addConnection(new ConnectionContext({ id: fixture.session.sessionId, socket: replacement }));
            return encode(message);
        });
        await fixture.remoteBridge.subscriber?.(toPubSubMessage({ channel: 'events', publisherId: 'A', entry }));
        expect(fixture.target.sent).toEqual([]);
        expect(replacement.sent).toEqual([]);
        expect(fixture.outsider.sent).toEqual([]);
    });

    it('replays auth completion without another notice and delivers captured authority after producer proof removal', async () => {
        const fixture = await createFixture();
        const entry = await fixture.logout();
        expect(await fixture.auth.service.logoutSession({ requestId: 'logout', session: fixture.session })).toMatchObject({ right: { loggedOut: true } });
        expect([...fixture.auth.database.outboxEntries.values()]).toHaveLength(1);
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(() => fixture.bridge.published.length).toBe(1);
        await fixture.repository.deleteByKey(WS_OUTBOX_PROVENANCE_NAMESPACE, toWsOutboxProvenanceKey(entry.key));
        await fixture.remoteBridge.subscriber?.(toPubSubMessage({ channel: 'events', publisherId: 'A', entry }));
        expect(fixture.target.sent).toHaveLength(1);
        expect(fixture.outsider.sent).toEqual([]);
    });

    it('rolls back the session deletion, exact row and proof when commit fails', async () => {
        const fixture = await createFixture();
        fixture.failure.failCommit = true;
        const result = await runAuthInboxCommand({
            ...fixture.auth,
            minimumEntries: 2,
            pending: fixture.auth.service.logoutSession({ requestId: 'logout', session: fixture.session })
        });
        expect(result.left).toBeDefined();
        expect(fixture.failure.proofSeen).toBe(true);
        expect(await fixture.sessions.findBySessionId(fixture.session.sessionId)).toBeDefined();
        expect([...fixture.auth.database.outboxEntries.values()]).toEqual([]);
        expect(await fixture.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toEqual([]);
    });

    it('computes the proof before the write transaction and refuses a proof collision atomically', async () => {
        const fixture = await createFixture();
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const writesDuringHash: boolean[] = [];
        vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
            writesDuringHash.push(fixture.failure.inTransaction);
            return digest(algorithm, data);
        });
        const key = `v1:${JSON.stringify(['auth.session.logout', 'logout', fixture.session.sessionId])}`;
        await fixture.repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, key, 'occupied-proof', fixture.session.expiresAtEpochMs);
        const result = await runAuthInboxCommand({
            ...fixture.auth,
            minimumEntries: 2,
            pending: fixture.auth.service.logoutSession({ requestId: 'logout', session: fixture.session })
        });
        expect(result.left).toBeDefined();
        expect(writesDuringHash.length).toBeGreaterThan(0);
        expect(writesDuringHash.every((inTransaction) => !inTransaction)).toBe(true);
        expect(await fixture.sessions.findBySessionId(fixture.session.sessionId)).toBeDefined();
        expect([...fixture.auth.database.outboxEntries.values()]).toEqual([]);
        expect((await fixture.repository.findEntry(WS_OUTBOX_PROVENANCE_NAMESPACE, key))?.value).toBe('occupied-proof');
    });

    it.each(['unproven', 'altered-payload'] as const)('refuses %s raw logout-shaped rows', async (kind) => {
        const fixture = await createFixture();
        const entry = await fixture.logout();
        if (kind === 'unproven') {
            await fixture.repository.deleteByKey(WS_OUTBOX_PROVENANCE_NAMESPACE, toWsOutboxProvenanceKey(entry.key));
        }
        const forged = kind === 'altered-payload'
            ? { ...entry, resource: entry.resource.replace('auth-logout\\"', 'forged-logout\\"') }
            : entry;
        if (kind === 'altered-payload') {
            expect(forged.resource).not.toBe(entry.resource);
        }
        await fixture.stores.workQueue.enqueue(forged);
        await fixture.engine.executeOnce();
        await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe('NON_RETRYABLE');
        expect(fixture.bridge.published).toEqual([]);
        expect(fixture.target.sent).toEqual([]);
    });
});

async function createFixture(cluster = true): Promise<LogoutFixture> {
    const repository = new FakeRuntimeStateRepository();
    const failure = { failCommit: false, proofSeen: false, inTransaction: false };
    const auth = createAuthInboxTestRuntime({
        runtimeRepository: repository,
        serviceId: 'A',
        credentialSecret: 'logout-proof-secret-0123456789abcdef',
        databaseOptions: {
            withTransaction: async (write) => {
                failure.inTransaction = true;
                try {
                    return await write();
                }
                finally {
                    failure.inTransaction = false;
                }
            },
            onStage: async (stage) => {
                if (failure.failCommit && stage === 'transaction-commit-return') {
                    failure.failCommit = false;
                    failure.proofSeen = (await repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).length === 1;
                    throw new NonRetryableException('Injected commit failure');
                }
            }
        }
    });
    const session = await issueSession(auth, repository);
    const delivery = await createCluster(repository, session.sessionId, cluster);
    return {
        ...delivery,
        auth,
        repository,
        failure,
        session,
        sessions: new AuthSessionRepository(repository),
        logout: async (): Promise<ResourceEntry> => {
            const result = await runAuthInboxCommand({ ...auth, minimumEntries: 2, pending: auth.service.logoutSession({ requestId: 'logout', session }) });
            expect(result.left).toBeUndefined();
            const entries = [...auth.database.outboxEntries.values()];
            expect(entries).toHaveLength(1);
            return entries[0]!;
        }
    };
}

async function issueSession(auth: AuthInboxTestRuntime, repository: FakeRuntimeStateRepository): Promise<IssuedAuthSession> {
    const issued = await runAuthInboxCommand({
        ...auth,
        pending: auth.service.issueSession({
            requestId: 'issue',
            clientId: 'client',
            username: 'alice',
            authority: { kind: 'static-client', clientId: 'client', normalizedUsername: 'alice' },
            ttlMs: 60_000
        })
    });
    if (!issued.right) {
        throw new Error('Session issuance failed');
    }
    const persisted = await new AuthSessionRepository(repository).findBySessionId(issued.right.sessionId);
    if (!persisted) {
        throw new Error('Issued session missing');
    }
    return { ...issued.right, issuedAtEpochMs: persisted.issuedAtEpochMs };
}

async function createCluster(repository: FakeRuntimeStateRepository, sessionId: string, cluster: boolean): Promise<LogoutDeliveryFixture> {
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const reader = new WsOutboxProvenanceReader({ repository, nowMs: Date.now });
    const engine = new InboxOutboxEngine();
    const remoteEngine = new InboxOutboxEngine();
    const remoteSocket = new JsonWebSocketServer();
    const target = addSocket(remoteSocket, sessionId);
    const outsider = addSocket(remoteSocket, 'outsider');
    const service = createDefaultWsQueueBoxServerService({
        name: 'A',
        socket: cluster ? new JsonWebSocketServer() : remoteSocket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        targetResolver: { resolvePeerRecipients: () => [{ peerId: sessionId, connectionId: 'outsider' }] },
        readProducerProvenance: (message, entry) => reader.readProducerProvenance(message, entry)
    });
    const remoteService = createDefaultWsQueueBoxServerService({
        name: 'B',
        socket: remoteSocket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: remoteEngine,
        readProducerProvenance: (message, entry) => reader.readProducerProvenance(message, entry)
    });
    const bridge = new RecordingBridge();
    const remoteBridge = new RecordingBridge();
    if (cluster) {
        await installQueueBoxPubSubBridge({ wsQBoxServerService: service, bridge, channel: 'events', publisherId: 'A' });
        await installQueueBoxPubSubBridge({ wsQBoxServerService: remoteService, bridge: remoteBridge, channel: 'events', publisherId: 'B' });
    }
    onTestFinished(() => {
        service.dispose();
        remoteService.dispose();
        engine.stop();
        remoteEngine.stop();
        vi.restoreAllMocks();
    });
    return { stores, reader, engine, bridge, remoteBridge, remoteSocket, target, outsider };
}

function addSocket(server: JsonWebSocketServer, id: string): TestWebSocket {
    const socket = new TestWebSocket(`ws://${id}`);
    socket.open();
    server.addConnection(new ConnectionContext({ id, socket }));
    return socket;
}

class RecordingBridge implements QueueBoxPubSubBridge {
    readonly published: QueueBoxPubSubMessage[] = [];
    subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1] | undefined;
    async publish(_channel: string, message: QueueBoxPubSubMessage): Promise<void> {
        this.published.push(message);
    }
    async subscribe(_channel: string, subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1]): Promise<void> {
        this.subscriber = subscriber;
    }
}
