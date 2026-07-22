import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
    NonRetryableException,
    ResilienceDto,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    type Key,
    type ResourceEntry,
    toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
    AppClientInboxService,
    AppInboxType,
    type ClientExpiredSessionsAppInboxPayload,
    type ClientInstanceUpsertAppInboxPayload,
    type ClientPrincipalUpsertAppInboxPayload,
    type ClientSessionConnectAppInboxPayload,
    type ClientSessionDisconnectAppInboxPayload,
    type ClientSessionHeartbeatAppInboxPayload,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import {
    type ClientMutationWritten,
    type ClientStateService,
    type ClientStateWritten,
    createClientStateService,
    toClientMutationCommand,
    toClientMutationIssuedSessionAuthority,
    toUpsertPrincipalCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import {
    AuthSessionRepository,
    type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';

const SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
};
const TEST_AUTHORITIES = new WeakMap<
    AppClientInboxService,
    Map<string, IssuedAuthSession>
>();

describe('AppClientInboxService', () => {
    it('does not trust a persisted Mallory actor claim for Alice authority', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const authSessions = new AuthSessionRepository(runtimeRepository);
        const mallory = issuedSession('mallory', 'mallory-session');
        await authSessions.putSession(mallory);
        const service = createClientStateService({
            runtimeRepository,
            serviceId: 'server-12345678',
        });
        const command = await toClientMutationCommand(
            toUpsertPrincipalCommandInput(
                SCOPE,
                'alice',
                {
                    username: 'alice',
                    displayName: 'Mallory controlled',
                    actorPrincipalId: 'mallory',
                    actorSessionId: 'mallory-session',
                    requestId: 'direct-mallory-targets-alice',
                },
                'direct-mallory-targets-alice',
            ),
            {
                nowEpochMs: Date.now(),
                serviceId: 'server-12345678',
                eventId: 'direct-mallory-targets-alice-event',
                attemptCount: 1,
                expireAtEpochMs: Date.now() + 60_000,
            },
            toClientMutationIssuedSessionAuthority(
                mallory,
                SCOPE,
                'upsertPrincipal',
            ),
        );
        const read = await service.read(command);
        const computed = service.compute(command, read);

        expect(() => service.validate(command, read, computed))
            .toThrow(/authority|authenticated|principal/i);
    });

    it('rejects a durable Mallory authority targeting Alice before any domain write', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
        });
        const authSessions = new AuthSessionRepository(runtimeRepository);
        const mallory = issuedSession('mallory', 'mallory-session');
        await authSessions.putSession(mallory);
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createClientStateService({
                runtimeRepository,
                createClientStateEventStore: () => new InMemoryClientStateEventStore(),
                serviceId: 'server-12345678',
            }),
            'server-12345678',
        );

        await expect(processAuthenticatedClientMutation(service, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'mallory-targets-alice',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'mallory',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'Mallory controlled',
                    actorPrincipalId: 'mallory',
                    requestId: 'mallory-targets-alice',
                },
            },
        }, mallory)).rejects.toThrow(/principal|authority|authenticated/i);

        expect(await new ClientStateRepository(runtimeRepository).readSnapshot({
            ...SCOPE,
            principalId: 'alice',
        })).toBeUndefined();
        expect(database.outboxEntries.size).toBe(0);
    });

    it('rereads revoked durable authority after an outer AppInbox CAS retry', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const authSessions = new AuthSessionRepository(runtimeRepository);
        const alice = issuedSession('alice', 'alice-session');
        await authSessions.putSession(alice);
        let injectedConflict = false;
        runtimeRepository.beforeConditionalWrite = async (
            operation,
            namespace,
            key,
        ) => {
            if (
                !injectedConflict && operation === 'insertIfAbsent' &&
                namespace === 'client-state:principals'
            ) {
                injectedConflict = true;
                runtimeRepository.data.set(`${namespace}::${key}`, {
                    key,
                    value: JSON.stringify({ competing: true }),
                    expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                    updatedTimestamp: new Date().toISOString(),
                    revision: 0,
                });
            }
        };
        let revoked = false;
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
            onTransactionRollback: async () => {
                if (injectedConflict && !revoked) {
                    revoked = true;
                    await authSessions.deleteSession(alice);
                }
            },
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createClientStateService({
                runtimeRepository,
                createClientStateEventStore: () => new InMemoryClientStateEventStore(),
                serviceId: 'server-12345678',
            }),
            'server-12345678',
        );
        const pending = processAuthenticatedClientMutation(service, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'alice-revoked-after-conflict',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'Must not commit',
                    actorPrincipalId: 'alice',
                    requestId: 'alice-revoked-after-conflict',
                },
            },
        }, alice);

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        await new Promise((resolve) => setTimeout(resolve, 2));
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        const result = await pending;
        expect(result.left).toMatch(/expired|missing|revoked|authority|authenticated/i);
        expect(revoked).toBe(true);
        expect(await new ClientStateRepository(runtimeRepository).readSnapshot({
            ...SCOPE,
            principalId: 'alice',
        })).toBeUndefined();
        expect(database.outboxEntries.size).toBe(0);
        const [entry] = await readEntries(queue);
        expect(entry.dequeueAudit.attempts).toBe(2);
    });

    it('restarts client phases from read after an AppInbox CAS conflict', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const phases: string[] = [];
        const serviceLocalSleeps: number[] = [];
        let writeAttempt = 0;
        let legacyAttempt = 0;
        const phasedClientState = createClientStateServiceStub({
            upsertPrincipal: vi.fn(async () => {
                legacyAttempt += 1;
                if (legacyAttempt === 1) {
                    throw new RuntimeStateWriteConflictError();
                }
                return { status: 'ok', result: { right: { accepted: true } } };
            }),
            read: vi.fn(async () => {
                phases.push('read');
                return { lifecycle: writeAttempt === 0 ? 'active' : 'disabled' };
            }),
            compute: vi.fn((_command, read) => {
                phases.push('compute');
                return {
                    outcome: 'write',
                    lifecycle: (read as { lifecycle: string }).lifecycle,
                    snapshot: { recomputed: true },
                    event: null,
                };
            }),
            validate: vi.fn(() => {
                phases.push('validate');
            }),
            write: vi.fn(async () => {
                writeAttempt += 1;
                if (writeAttempt === 1) {
                    phases.push('write-conflict');
                    throw new RuntimeStateWriteConflictError();
                }
                phases.push('write-accepted');
                return {
                    commandId: 'retry-client-alice',
                    requestId: 'retry-client-alice',
                    commandHash: `sha256:${'a'.repeat(64)}`,
                    aggregateRef: { ...SCOPE, principalId: 'alice' },
                    outcome: 'no-op',
                    attemptCount: 2,
                    acceptedStorageRevision: 0,
                    stateRevision: 1,
                    snapshotVersion: 1,
                    presenceVersion: 1,
                    eventId: null,
                    outboxIds: [],
                };
            }),
            sleep: vi.fn(async (delayMs: number) => {
                serviceLocalSleeps.push(delayMs);
            }),
        } as never);
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results),
            phasedClientState,
            'server-12345678',
        );

        const resultPromise = processAuthenticatedClientMutation(service, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'retry-client-alice',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'recomputed-successor',
                    actorPrincipalId: 'alice',
                    requestId: 'retry-client-alice',
                },
            },
        }, issuedSession('alice', 'alice-test-session'));

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await new Promise((resolve) => setTimeout(resolve, 2));
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await resultPromise;

        expect(phases).toEqual([
            'read',
            'compute',
            'validate',
            'write-conflict',
            'read',
            'compute',
            'validate',
            'write-accepted',
        ]);
        expect(serviceLocalSleeps).toEqual([]);
        const [entry] = await readEntries(queue);
        expect(entry.dequeueAudit.attempts).toBe(2);
    });

    it('processes principal, instance, and session mutations through the inbox', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
        });
        const connectedAtEpochMs = Date.now();
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createAutoAuthorizingClientStateService(runtimeRepository, database),
            'server-12345678',
        );

        const principal = await processAppInbox<
            ClientPrincipalUpsertAppInboxPayload,
            ClientStateWritten
        >(service, reader, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'upsert-client-alice',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'Alice',
                    actorPrincipalId: 'alice',
                    requestId: 'upsert-client-alice',
                },
            },
        });
        const instance = await processAppInbox<
            ClientInstanceUpsertAppInboxPayload,
            ClientStateWritten
        >(service, reader, {
            type: AppInboxType.CLIENT_INSTANCE_UPSERT,
            resourceId: 'upsert-client-alice-instance',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                clientInstanceId: 'alice-browser',
                request: {
                    platform: 'web',
                    capabilities: ['ws'],
                    actorPrincipalId: 'alice',
                    requestId: 'upsert-client-alice-instance',
                },
            },
        });
        const connected = await processAppInbox<
            ClientSessionConnectAppInboxPayload,
            ClientStateWritten
        >(service, reader, {
            type: AppInboxType.CLIENT_SESSION_CONNECT,
            resourceId: 'connect-client-alice-session',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                clientInstanceId: 'alice-browser',
                sessionId: 'alice-session',
                request: {
                    generationId: 'generation-alice-session',
                    presenceState: 'online',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    connectedAtEpochMs,
                    lastHeartbeatAtEpochMs: connectedAtEpochMs,
                    expiresAtEpochMs: connectedAtEpochMs + 60_000,
                    requestId: 'connect-client-alice-session',
                },
            },
        });
        const heartbeat = await processAppInbox<
            ClientSessionHeartbeatAppInboxPayload,
            ClientStateWritten
        >(service, reader, {
            type: AppInboxType.CLIENT_SESSION_HEARTBEAT,
            resourceId: 'heartbeat-client-alice-session',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                clientInstanceId: 'alice-browser',
                sessionId: 'alice-session',
                request: {
                    generationId: 'generation-alice-session',
                    presenceState: 'away',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    lastHeartbeatAtEpochMs: connectedAtEpochMs + 1,
                    expiresAtEpochMs: connectedAtEpochMs + 60_001,
                    requestId: 'heartbeat-client-alice-session',
                },
            },
        });
        const disconnected = await processAppInbox<
            ClientSessionDisconnectAppInboxPayload,
            ClientStateWritten
        >(service, reader, {
            type: AppInboxType.CLIENT_SESSION_DISCONNECT,
            resourceId: 'disconnect-client-alice-session',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                clientInstanceId: 'alice-browser',
                sessionId: 'alice-session',
                request: {
                    generationId: 'generation-alice-session',
                    reason: 'closed',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'disconnect-client-alice-session',
                },
            },
        });

        expect(requireRightSnapshot(principal).principal.displayName).toBe('Alice');
        expect(requireRightSnapshot(instance).instances[0]).toMatchObject({
            clientInstanceId: 'alice-browser',
            platform: 'web',
        });
        expect(requireRightSnapshot(connected).activeSessions).toHaveLength(1);
        expect(requireRightSnapshot(heartbeat).activeSessions[0]).toMatchObject({
            sessionId: 'alice-session',
            presenceState: 'away',
            lastHeartbeatAtEpochMs: connectedAtEpochMs + 1,
        });
        expect(requireRightSnapshot(disconnected).activeSessions).toHaveLength(0);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('replays stored idempotent mutation results without direct publication', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createAutoAuthorizingClientStateService(runtimeRepository, database),
            'server-12345678',
        );

        const first = await processAppInbox<
            ClientPrincipalUpsertAppInboxPayload,
            ClientStateWritten
        >(service, reader, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'upsert-client-alice-first',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'Alice',
                    actorPrincipalId: 'alice',
                    requestId: 'upsert-client-alice',
                },
            },
        });
        vi.mocked(publisher.publishClientSnapshot).mockClear();
        vi.mocked(publisher.publishClientEvent).mockClear();

        const replay = await processAppInbox<
            ClientPrincipalUpsertAppInboxPayload,
            ClientStateWritten
        >(service, reader, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'upsert-client-alice-replay',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'Alice',
                    actorPrincipalId: 'alice',
                    requestId: 'upsert-client-alice',
                },
            },
        });

        expect(requireRightSnapshot(replay).principal.displayName).toBe('Alice');
        expect(requireRightWritten(replay).event).toEqual(
            requireRightWritten(first).event);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('rolls back every client mutation surface when final WS outbox insertion fails', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const eventStore = new InMemoryClientStateEventStore();
        const repository = new ClientStateRepository(runtimeRepository, {
            events: eventStore,
        });
        const key = {
            topicId: 'app-inbox.client-state',
            resourceId: 'connect-client-rollback',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
        };
        let failOutbox = true;
        let rollbackAssertions = 0;
        let database!: ReturnType<typeof createAppInboxTestDatabase>;
        database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
            clientEventStore: eventStore,
            shouldFailOutboxWrite: () => {
                if (!failOutbox) return false;
                failOutbox = false;
                return true;
            },
            withTransaction: async (write) => {
                const before = [...eventStore.events];
                try {
                    return await write();
                } catch (error) {
                    eventStore.events.length = 0;
                    eventStore.events.push(...before);
                    throw error;
                }
            },
            onTransactionRollback: async () => {
                rollbackAssertions += 1;
                expect(
                    await repository.findPrincipal({
                        ...SCOPE,
                        principalId: 'alice',
                    }),
                ).toBeUndefined();
                expect(
                    await repository.findInstance({
                        ...SCOPE,
                        principalId: 'alice',
                        clientInstanceId: 'alice-browser',
                    }),
                ).toBeUndefined();
                expect(
                    await repository.findSession({
                        ...SCOPE,
                        principalId: 'alice',
                        clientInstanceId: 'alice-browser',
                        sessionId: 'alice-session',
                    }),
                ).toBeUndefined();
                expect(
                    await repository.findIdempotentClientMutationReceipt(
                        { ...SCOPE, principalId: 'alice' },
                        'connect-client-rollback',
                    ),
                ).toBeUndefined();
                expect(
                    await repository.listEvents({
                        ...SCOPE,
                        principalId: 'alice',
                    }),
                ).toEqual([]);
                expect(database.outboxEntries.size).toBe(0);
                expect(await results.findByKey(key)).toBeUndefined();
                expect((await queue.getItem(key))?.status).toBe(EntityStatus.RESERVED);
            },
        });
        const clientStateService = createAutoAuthorizingClientStateService(
            runtimeRepository,
            database,
            eventStore,
        );
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            clientStateService,
            'server-12345678',
        );
        const connectedAtEpochMs = Date.now();

        const result = await processAppInbox<
            ClientSessionConnectAppInboxPayload,
            ClientStateWritten
        >(service, reader, {
            type: AppInboxType.CLIENT_SESSION_CONNECT,
            ...key,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                clientInstanceId: 'alice-browser',
                sessionId: 'alice-session',
                request: {
                    generationId: 'rollback-generation',
                    connectedAtEpochMs,
                    lastHeartbeatAtEpochMs: connectedAtEpochMs,
                    expiresAtEpochMs: connectedAtEpochMs + 60_000,
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'connect-client-rollback',
                },
            },
        });

        expect(result.left).toContain('resource-inbox-invariant-corruption');
        expect(rollbackAssertions).toBe(1);
        expect((await queue.getItem(key))?.status).toBe(EntityStatus.FAILED);
        expect(await results.findByKey(key)).toMatchObject({
            status: EntityStatus.FAILED,
        });
    });

    it('rejects authorised websocket disconnect after durable auth revocation', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const authSession = issuedSession('alice', 'alice-ws-session');
        const runtimeRepository = new FakeRuntimeStateRepository();
        const authSessions = new AuthSessionRepository(runtimeRepository);
        await authSessions.putSession(authSession);
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createClientStateService({
                runtimeRepository,
                createClientStateEventStore: () => database.clientEventStore,
                serviceId: 'server-12345678',
            }),
            'server-12345678',
        );

        const connected = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, 'generation-1', {
                expiresAtEpochMs: Date.now() + 60_000,
                userAgent: 'Browser',
            }),
        );
        vi.mocked(publisher.publishClientSnapshot).mockClear();
        vi.mocked(publisher.publishClientEvent).mockClear();
        await authSessions.deleteSession(authSession);
        await expect(
            service.processAuthorisedWsClientDisconnect(
                authSession.sessionId,
                'generation-1',
                'socket-closed',
            ),
        ).rejects.toThrow(/authority|auth session/i);

        expect(requireRightSnapshot(connected).activeSessions).toHaveLength(1);
        expect(requireRightSnapshot(connected).instances[0]).toMatchObject({
            clientInstanceId: 'alice',
            userAgent: 'Browser',
        });
        expect(requireRightSnapshot(connected).activeSessions).toHaveLength(1);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('processes authorised websocket connects in the requested state scope', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const authSession = issuedSession('admin', 'admin-ws-session');
        const runtimeRepository = new FakeRuntimeStateRepository();
        await new AuthSessionRepository(runtimeRepository).putSession(authSession);
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createClientStateService({
                runtimeRepository,
                createClientStateEventStore: () => database.clientEventStore,
                serviceId: 'server-12345678',
            }),
            'server-12345678',
        );

        const connected = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, 'generation-admin', {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                expiresAtEpochMs: Date.now() + 60_000,
                userAgent: 'Browser',
            }),
        );

        const snapshot = requireRightSnapshot(connected);
        expect(snapshot.principal).toMatchObject({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: 'admin',
            username: 'admin',
        });
        expect(snapshot.instances[0]).toMatchObject({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            clientInstanceId: 'admin',
            userAgent: 'Browser',
        });
        expect(snapshot.activeSessions[0]).toMatchObject({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            clientInstanceId: 'admin',
            sessionId: 'admin-ws-session',
            transport: 'ws',
        });
    });

    it('processes authorised websocket connects independently per state scope', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const authSession = issuedSession('admin', 'admin-ws-session');
        const runtimeRepository = new FakeRuntimeStateRepository();
        await new AuthSessionRepository(runtimeRepository).putSession(authSession);
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createClientStateService({
                runtimeRepository,
                createClientStateEventStore: () => database.clientEventStore,
                serviceId: 'server-12345678',
            }),
            'server-12345678',
        );

        const defaultConnect = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, 'generation-default', {
                applicationId: 'rallar-server',
                workspaceId: 'default',
            }),
        );
        const scopedConnect = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, 'generation-scoped', {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
            }),
        );

        expect(requireRightSnapshot(defaultConnect).principal).toMatchObject({
            applicationId: 'rallar-server',
            workspaceId: 'default',
        });
        expect(requireRightSnapshot(scopedConnect).principal).toMatchObject({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
        });
    });

    it('disconnects authorised websocket sessions from their connected state scope while auth exists', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const authSession = issuedSession('admin', 'admin-ws-session');
        const runtimeRepository = new FakeRuntimeStateRepository();
        await new AuthSessionRepository(runtimeRepository).putSession(authSession);
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createClientStateService({
                runtimeRepository,
                createClientStateEventStore: () => database.clientEventStore,
                serviceId: 'server-12345678',
            }),
            'server-12345678',
        );

        await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, 'generation-scoped', {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                expiresAtEpochMs: Date.now() + 60_000,
            }),
        );
        const disconnected = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientDisconnect(
                authSession.sessionId,
                'generation-scoped',
                'socket-closed',
            ),
        );

        expect(requireRightSnapshot(disconnected).principal).toMatchObject({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: 'admin',
        });
        expect(requireRightSnapshot(disconnected).activeSessions).toHaveLength(0);
        expect(requireRightWritten(disconnected).event).toMatchObject({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            eventType: 'session-disconnected',
        });
    });

    it('processes expired client sessions through the inbox and publishes written mutations', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const publisher = createPublisher();
        const expiresAtEpochMs = Date.now() - 1_000;
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository,
        });
        const clientStateService = createAutoAuthorizingClientStateService(
            runtimeRepository,
            database,
        );
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            database,
            clientStateService,
            'server-12345678',
        );
        await processAppInbox<ClientSessionConnectAppInboxPayload, ClientStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.CLIENT_SESSION_CONNECT,
                resourceId: 'seed-client-expiry-session',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
                senderId: 'alice',
                data: {
                    scope: SCOPE,
                    principalId: 'alice',
                    clientInstanceId: 'alice-browser',
                    sessionId: 'alice-session',
                    request: {
                        generationId: 'generation-alice-session',
                        presenceState: 'online',
                        actorPrincipalId: 'alice',
                        actorSessionId: 'alice-session',
                        connectedAtEpochMs: expiresAtEpochMs - 2_000,
                        lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
                        expiresAtEpochMs,
                        requestId: 'seed-client-expiry-session',
                    },
                },
            },
        );

        const expired = await processAppInboxMethod(reader, () =>
            service.processExpiredSessions(expiresAtEpochMs + 1),
        );

        expect(expired.right).toHaveLength(1);
        expect(expired.right?.[0].result.right?.event).toMatchObject({
            eventType: 'session-expired',
            reason: 'expired',
            sessionId: 'alice-session',
        });
        expect(expired.right?.[0].result.right?.snapshot.activeSessions).toEqual([]);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('keeps at most one active no-wait client expiry entry across timestamps', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const clientStateService = createClientStateServiceStub({
            listExpiredSessionCandidates: vi.fn(async () => []),
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results),
            clientStateService,
            'server-12345678',
        );

        service.processExpiredSessionsNoWaiting(60_000);
        service.processExpiredSessionsNoWaiting(120_000);

        await waitForQueueEntryCount(queue, 1);
        const entries = await readEntries(queue);

        expect(activeEntries(entries)).toHaveLength(1);
        expect(entries[0].key.resourceId).toBe('expire-client-sessions');
        expect(readEnqueuedData<ClientExpiredSessionsAppInboxPayload>(entries[0]).atEpochMs).toBe(
            60_000,
        );
        expect(clientStateService.listExpiredSessionCandidates).not.toHaveBeenCalled();
    });

    it('keeps at most one active waiting client expiry entry across timestamps', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const listExpiredSessionCandidates = vi.fn(async () => []);
        const clientStateService = createClientStateServiceStub({
            listExpiredSessionCandidates,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results),
            clientStateService,
            'server-12345678',
        );

        const first = service.processExpiredSessions(60_000);
        const second = service.processExpiredSessions(120_000);

        await waitForQueueEntryCount(queue, 1);
        const entries = await readEntries(queue);

        expect(activeEntries(entries)).toHaveLength(1);
        expect(entries[0].key.resourceId).toBe('expire-client-sessions');
        expect(readEnqueuedData<ClientExpiredSessionsAppInboxPayload>(entries[0]).atEpochMs).toBe(
            60_000,
        );

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(first).resolves.toMatchObject({ right: [] });
        await expect(second).resolves.toMatchObject({ right: [] });
        expect(listExpiredSessionCandidates).toHaveBeenCalledTimes(1);
        expect(listExpiredSessionCandidates).toHaveBeenLastCalledWith(60_000);
    });

    it('does not replace reserved or retry client expiry entries', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const clientStateService = createClientStateServiceStub({
            listExpiredSessionCandidates: vi.fn(async () => []),
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results),
            clientStateService,
            'server-12345678',
        );

        service.processExpiredSessionsNoWaiting(60_000);
        await waitForQueueEntryCount(queue, 1);
        let [entry] = await readEntries(queue);
        const reserved = await queue.reserveEntries(
            new Set([entry.typeId]),
            new Set([EntityStatus.NEW]),
            1,
        );
        [entry] = reserved.values();

        service.processExpiredSessionsNoWaiting(120_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        [entry] = await readEntries(queue);
        expect(activeEntries([entry])).toHaveLength(1);
        expect(entry.status).toBe(EntityStatus.RESERVED);
        expect(readEnqueuedData<ClientExpiredSessionsAppInboxPayload>(entry).atEpochMs).toBe(
            60_000,
        );

        await queue.releaseEntries([entry], { status: EntityStatus.RETRY, delayMs: 1 });

        service.processExpiredSessionsNoWaiting(180_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        [entry] = await readEntries(queue);
        expect(activeEntries([entry])).toHaveLength(1);
        expect(entry.status).toBe(EntityStatus.RETRY);
        expect(readEnqueuedData<ClientExpiredSessionsAppInboxPayload>(entry).atEpochMs).toBe(
            60_000,
        );
    });

    it('skips active client expiry entries and replaces completed ones', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const listExpiredSessionCandidates = vi.fn(async () => []);
        const clientStateService = createClientStateServiceStub({
            listExpiredSessionCandidates,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results),
            clientStateService,
            'server-12345678',
        );

        service.processExpiredSessionsNoWaiting(60_000);
        service.processExpiredSessionsNoWaiting(120_000);

        await waitForQueueEntryCount(queue, 1);
        let [entry] = await readEntries(queue);
        expect(activeEntries([entry])).toHaveLength(1);
        expect(entry.key.resourceId).toBe('expire-client-sessions');
        expect(readEnqueuedData<ClientExpiredSessionsAppInboxPayload>(entry).atEpochMs).toBe(
            60_000,
        );

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(listExpiredSessionCandidates).toHaveBeenCalledTimes(1);
        expect(listExpiredSessionCandidates).toHaveBeenLastCalledWith(60_000);

        service.processExpiredSessionsNoWaiting(120_000);

        await waitForQueueEntryStatus(queue, EntityStatus.NEW);
        [entry] = await readEntries(queue);
        expect(entry.status).toBe(EntityStatus.NEW);
        expect(readEnqueuedData<ClientExpiredSessionsAppInboxPayload>(entry).atEpochMs).toBe(
            120_000,
        );

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(listExpiredSessionCandidates).toHaveBeenCalledTimes(2);
        expect(listExpiredSessionCandidates).toHaveBeenLastCalledWith(120_000);
    });

    it('returns a left result when a client inbox mutation handler fails with a non-retryable error', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results),
            createClientStateServiceStub({
                read: vi.fn(async () => {
                    throw new NonRetryableException('Client principal update failed');
                }),
            }),
            'server-12345678',
        );

        const result = await processAppInbox<
            ClientPrincipalUpsertAppInboxPayload,
            ClientSnapshot
        >(service, reader, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'upsert-client-fail',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    actorPrincipalId: 'alice',
                    requestId: 'upsert-client-fail',
                },
                },
            },
        );

        expect(result.left).toBe('Client principal update failed');
    });
});

class TestResourceInbox extends InMemoryQueueBox {
    async isEntryWithStatus(
        key: Key,
        statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }
}
function requireRightSnapshot(
    result: Either<string, ClientStateWritten>): ClientSnapshot {
    if (!result.right) {
        throw new Error(result.left ?? 'Expected client app-inbox right result');
    }

    return requireClientStateWrittenSnapshot(result.right);
}

function requireRightWritten(
    result: Either<string, ClientStateWritten>): ClientMutationWritten {
    if (!result.right) {
        throw new Error(result.left ?? 'Expected client app-inbox right result');
    }

    return requireClientMutationWritten(result.right);
}

function requireClientStateWrittenSnapshot(written: ClientStateWritten): ClientSnapshot {
    return requireClientMutationWritten(written).snapshot;
}

function requireClientMutationWritten(written: ClientStateWritten): ClientMutationWritten {
    const result = written.result as
        | ClientStateWritten['result']
        | {
        left?: string;
        right?: ClientMutationWritten;
    };

    if ('fold' in result && typeof result.fold === 'function') {
        return result.fold(
            (error) => {
                throw new Error(error);
            },
            (value) => value,
        );
    }

    if (result.right) {
        return result.right;
    }

    throw new Error(result.left ?? 'Client mutation failed');
}

class TestResourceInboxResults {
    private readonly data = new Map<string, ResourceEntry>();

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async writeIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry> {
        const key = toKeyAsString(entry.key);
        const existing = this.data.get(key);
        if (existing !== undefined && !isExpiredResourceEntry(existing)) {
            return existing;
        }

        this.data.set(key, entry);
        return entry;
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        return entry === undefined || isExpiredResourceEntry(entry)
            ? undefined
            : entry;
    }
}

async function processAppInbox<V, R>(
    service: AppClientInboxService,
    reader: InboxQueueReader,
    input: {
        type: AppInboxType;
        topicId?: string;
        resourceId?: string;
        contextId?: string;
        senderId?: string;
        data: V;
    },
): Promise<Either<string, R>> {
    const resultPromise = service.processAuthenticatedEntryUntilCompletion<V, R>(
        input,
        toTestIssuedAuthority(service, input),
    );
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

    return await resultPromise;
}

function toTestIssuedAuthority<V>(
    service: AppClientInboxService,
    input: Readonly<{
    senderId?: string;
    data: V;
    }>,
): IssuedAuthSession {
    const data = typeof input.data === 'object' && input.data !== null
        ? Object.fromEntries(Object.entries(input.data))
        : {};
    const request = typeof data.request === 'object' && data.request !== null
        ? Object.fromEntries(Object.entries(data.request))
        : {};
    const principalId = typeof data.principalId === 'string'
        ? data.principalId
        : input.senderId ?? 'alice';
    const sessionId = typeof data.sessionId === 'string'
        ? data.sessionId
        : typeof request.actorSessionId === 'string'
        ? request.actorSessionId
        : `${principalId}-test-authority-session`;
    let authorities = TEST_AUTHORITIES.get(service);
    if (!authorities) {
        authorities = new Map();
        TEST_AUTHORITIES.set(service, authorities);
    }
    const key = `${principalId}:${sessionId}`;
    const existing = authorities.get(key);
    if (existing) return existing;
    const created = issuedSession(principalId, sessionId);
    authorities.set(key, created);
    return created;
}

async function processAuthenticatedClientMutation<V, R = ClientStateWritten>(
    service: AppClientInboxService,
    input: {
        type: AppInboxType;
        topicId?: string;
        resourceId?: string;
        contextId?: string;
        senderId?: string;
        data: V;
    },
    authority: IssuedAuthSession,
): Promise<Either<string, R>> {
    const authenticated = service as unknown as Readonly<{
        processAuthenticatedEntryUntilCompletion<V, R = V>(
            enqueue: typeof input,
            authority: IssuedAuthSession,
        ): Promise<Either<string, R>>;
    }>;
    return await authenticated.processAuthenticatedEntryUntilCompletion<V, R>(
        input,
        authority,
    );
}

function issuedSession(
    clientId: string,
    sessionId: string,
): IssuedAuthSession {
    const nowEpochMs = Date.now();
    return {
        clientId,
        accessToken: `${clientId}-token`,
        username: clientId,
        sessionId,
        issuedAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: nowEpochMs + 60_000,
    };
}

async function processAppInboxMethod<R>(
    reader: InboxQueueReader,
    run: () => Promise<R>,
): Promise<R> {
    const resultPromise = run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

    return await resultPromise;
}

async function waitForQueueEntryCount(
    queue: InMemoryQueueBox, count: number): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if ((await readEntries(queue)).length >= count) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error(`Expected at least ${count} app inbox entries`);
}

async function waitForQueueEntryStatus(
    queue: InMemoryQueueBox,
    status: EntityStatus,
): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if ((await readEntries(queue)).some((entry) => entry.status === status)) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error(`Expected app inbox entry with status ${status}`);
}

async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
    const entries = await Promise.all(
        (await queue.getAllKeys()).map((key) => queue.getItem(key)));

    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

function activeEntries(entries: ResourceEntry[]): ResourceEntry[] {
    const activeStatuses = new Set([
        EntityStatus.NEW,
        EntityStatus.RESERVED, EntityStatus.RETRY]);

    return entries.filter((entry) => activeStatuses.has(entry.status));
}

function readEnqueuedData<V>(entry: ResourceEntry): V {
    const message = JSON.parse(entry.resource) as {
        payload: {
            resource: string;
        };
    };
    const enqueue = JSON.parse(message.payload.resource) as {
        data: V;
    };

    return enqueue.data;
}

function createClientStateServiceStub(
    overrides: Partial<ClientStateService>): ClientStateService {
    return {
        listSnapshots: vi.fn(),
        readSnapshot: vi.fn(),
        readPresenceSnapshot: vi.fn(),
        listEvents: vi.fn(),
        listEventPage: vi.fn(),
        read: vi.fn(),
        compute: vi.fn(),
        validate: vi.fn(),
        write: vi.fn(),
        listExpiredSessionCandidates: vi.fn(async () => []),
        findSessionBySessionId: vi.fn(),
        readIssuedAuthSession: vi.fn(),
        observeSnapshot: vi.fn(async (snapshot) => snapshot),
        ...overrides,
    };
}

function createAutoAuthorizingClientStateService(
    runtimeRepository: FakeRuntimeStateRepository,
    database: ReturnType<typeof createAppInboxTestDatabase>,
    eventStore: InMemoryClientStateEventStore = database.clientEventStore,
): ClientStateService {
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const durable = createClientStateService({
        runtimeRepository,
        createClientStateEventStore: () => eventStore,
        serviceId: 'server-12345678',
    });
    return {
        ...durable,
        read: async (command) => {
            if (command.authority.kind === 'issued-session') {
                const existing = await authSessions.findBySessionId(
                    command.authority.sessionId,
                );
                if (!existing) {
                    await authSessions.putSession({
                        clientId: command.authority.principalId,
                        accessToken: `${command.authority.sessionId}-test-token`,
                        username: command.authority.principalId,
                        sessionId: command.authority.sessionId,
                        issuedAtEpochMs: command.authority.sessionIssuedAtEpochMs,
                        expiresAtEpochMs: command.authority.sessionExpiresAtEpochMs,
                    });
                }
            }
            return await durable.read(command);
        },
    };
}

function createPublisher() {
    return {
        publishClientSnapshot: vi.fn(
            async (_snapshot: unknown, _senderId?: string) => undefined),
        publishClientEvent: vi.fn(
            async (_event: unknown, _senderId?: string) => undefined),
        publishGroupSnapshot: vi.fn(
            async (_snapshot: unknown, _senderId?: string) => undefined),
        publishGroupEvent: vi.fn(
            async (_event: unknown, _senderId?: string) => undefined),
    };
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    );
}
