import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@shared/api/api-config.ts';
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
} from '@shared-server/rallar-system/services/client-state-service.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
};

describe('AppClientInboxService', () => {
    it('processes principal, instance, and session mutations through the inbox', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createClientStateService({
                runtimeRepository: new FakeRuntimeStateRepository(),
                syncPublisher: publisher,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
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
                    presenceState: 'online',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    lastHeartbeatAtEpochMs: 2_000,
                    expiresAtEpochMs: Date.now() + 60_000,
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
                    presenceState: 'away',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    lastHeartbeatAtEpochMs: 3_000,
                    expiresAtEpochMs: Date.now() + 60_000,
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
            lastHeartbeatAtEpochMs: 3_000,
        });
        expect(requireRightSnapshot(disconnected).activeSessions).toHaveLength(0);
        // TEMP(Task 3): remove this direct-publish characterization only after
        // every client mutation writes a transaction-local outbox intent.
        expect(publisher.publishClientSnapshot).toHaveBeenCalledTimes(5);
        expect(publisher.publishClientEvent).toHaveBeenCalledTimes(5);
    });

    it('publishes stored idempotent mutation results when the service replays a request', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createClientStateService({
                runtimeRepository: new FakeRuntimeStateRepository(),
                syncPublisher: publisher,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
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
                    displayName: 'Alice changed payload',
                    actorPrincipalId: 'alice',
                    requestId: 'upsert-client-alice',
                },
            },
        });

        expect(requireRightSnapshot(replay).principal.displayName).toBe('Alice');
        expect(requireRightWritten(replay).event).toEqual(
            requireRightWritten(first).event,
        );
        expect(publisher.publishClientSnapshot).toHaveBeenCalledTimes(1);
        expect(publisher.publishClientEvent).toHaveBeenCalledTimes(1);
        expect(vi.mocked(publisher.publishClientEvent).mock.calls[0]?.[0]).toEqual(
            requireRightWritten(first).event,
        );
    });

    it('processes authorised websocket lifecycle mutations through the inbox', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const authSession: AuthSession = {
            clientId: 'alice',
            username: 'alice',
            accessToken: 'secret-token',
            sessionId: 'alice-ws-session',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        let authSessionAvailable = true;
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createClientStateService({
                runtimeRepository: new FakeRuntimeStateRepository(),
                syncPublisher: publisher,
                authSessionRepository: {
                    findBySessionId: vi.fn(async (sessionId: string) =>
                        authSessionAvailable &&
                            sessionId === authSession.sessionId
                            ? {
                                ...authSession,
                                issuedAtEpochMs: 1_000,
                            }
                            : undefined
                    ),
                } as never,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        const connected = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, {
                expiresAtEpochMs: Date.now() + 60_000,
                userAgent: 'Browser',
            })
        );
        vi.mocked(publisher.publishClientSnapshot).mockClear();
        vi.mocked(publisher.publishClientEvent).mockClear();
        authSessionAvailable = false;
        const disconnected = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientDisconnect(
                authSession.sessionId,
                'socket-closed',
            )
        );

        expect(requireRightSnapshot(connected).activeSessions).toHaveLength(1);
        expect(requireRightSnapshot(connected).instances[0]).toMatchObject({
            clientInstanceId: 'alice',
            userAgent: 'Browser',
        });
        expect(requireRightSnapshot(disconnected).activeSessions).toHaveLength(0);
        expect(requireRightWritten(disconnected).event?.eventType).toBe(
            'session-disconnected',
        );
        expect(publisher.publishClientSnapshot).toHaveBeenCalledTimes(1);
        expect(publisher.publishClientEvent).toHaveBeenCalledTimes(1);
    });

    it('processes authorised websocket connects in the requested state scope', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = createPublisher();
        const authSession: AuthSession = {
            clientId: 'admin',
            username: 'admin',
            accessToken: 'secret-token',
            sessionId: 'admin-ws-session',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createClientStateService({
                runtimeRepository: new FakeRuntimeStateRepository(),
                syncPublisher: publisher,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        const connected = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                expiresAtEpochMs: Date.now() + 60_000,
                userAgent: 'Browser',
            })
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
        const authSession: AuthSession = {
            clientId: 'admin',
            username: 'admin',
            accessToken: 'secret-token',
            sessionId: 'admin-ws-session',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createClientStateService({
                runtimeRepository: new FakeRuntimeStateRepository(),
                syncPublisher: publisher,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        const defaultConnect = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, {
                applicationId: 'rallar-server',
                workspaceId: 'default',
            })
        );
        const scopedConnect = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
            })
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
        const authSession: AuthSession = {
            clientId: 'admin',
            username: 'admin',
            accessToken: 'secret-token',
            sessionId: 'admin-ws-session',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createClientStateService({
                runtimeRepository: new FakeRuntimeStateRepository(),
                syncPublisher: publisher,
                authSessionRepository: {
                    findBySessionId: vi.fn(async (sessionId: string) =>
                        sessionId === authSession.sessionId
                            ? {
                                ...authSession,
                                issuedAtEpochMs: 1_000,
                            }
                            : undefined
                    ),
                } as never,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                expiresAtEpochMs: Date.now() + 60_000,
            })
        );
        const disconnected = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientDisconnect(
                authSession.sessionId,
                'socket-closed',
            )
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
        let serviceNow = 2_000;
        const expiresAtEpochMs = Date.now() - 1_000;
        const clientStateService = createClientStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => serviceNow,
            serviceId: 'server-12345678',
        });
        await clientStateService.connectSession(
            SCOPE,
            'alice',
            'alice-browser',
            'alice-session',
            {
                presenceState: 'online',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
                expiresAtEpochMs,
                requestId: 'seed-client-expiry-session',
            },
        );
        serviceNow = expiresAtEpochMs + 1;

        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            clientStateService,
            publisher,
            'server-12345678',
        );

        const expired = await processAppInboxMethod(reader, () =>
            service.processExpiredSessions(serviceNow)
        );

        expect(expired.right).toHaveLength(1);
        expect(expired.right?.[0].result.right?.event).toMatchObject({
            eventType: 'session-expired',
            reason: 'expired',
            sessionId: 'alice-session',
        });
        expect(expired.right?.[0].result.right?.snapshot.activeSessions).toEqual([]);
        expect(publisher.publishClientSnapshot).toHaveBeenCalledTimes(1);
        expect(publisher.publishClientEvent).toHaveBeenCalledTimes(1);
    });

    it('keeps at most one active no-wait client expiry entry across timestamps', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const clientStateService = createClientStateServiceStub({
            expireExpiredSessions: vi.fn(async () => []),
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            clientStateService,
            createPublisher(),
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
        expect(clientStateService.expireExpiredSessions).not.toHaveBeenCalled();
    });

    it('keeps at most one active waiting client expiry entry across timestamps', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const expireExpiredSessions = vi.fn(async () => []);
        const clientStateService = createClientStateServiceStub({
            expireExpiredSessions,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            clientStateService,
            createPublisher(),
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
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        await expect(first).resolves.toMatchObject({ right: [] });
        await expect(second).resolves.toMatchObject({ right: [] });
        expect(expireExpiredSessions).toHaveBeenCalledTimes(1);
        expect(expireExpiredSessions).toHaveBeenLastCalledWith(60_000);
    });

    it('does not replace reserved or retry client expiry entries', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const clientStateService = createClientStateServiceStub({
            expireExpiredSessions: vi.fn(async () => []),
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            clientStateService,
            createPublisher(),
            'server-12345678',
        );

        service.processExpiredSessionsNoWaiting(60_000);
        await waitForQueueEntryCount(queue, 1);
        let [entry] = await readEntries(queue);
        await queue.releaseEntries([entry], EntityStatus.RESERVED);

        service.processExpiredSessionsNoWaiting(120_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        [entry] = await readEntries(queue);
        expect(activeEntries([entry])).toHaveLength(1);
        expect(entry.status).toBe(EntityStatus.RESERVED);
        expect(readEnqueuedData<ClientExpiredSessionsAppInboxPayload>(entry).atEpochMs).toBe(
            60_000,
        );

        await queue.releaseEntries([entry], EntityStatus.RETRY);

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
        const expireExpiredSessions = vi.fn(async () => []);
        const clientStateService = createClientStateServiceStub({
            expireExpiredSessions,
        });
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            clientStateService,
            createPublisher(),
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
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        expect(expireExpiredSessions).toHaveBeenCalledTimes(1);
        expect(expireExpiredSessions).toHaveBeenLastCalledWith(60_000);

        service.processExpiredSessionsNoWaiting(120_000);

        await waitForQueueEntryStatus(queue, EntityStatus.NEW);
        [entry] = await readEntries(queue);
        expect(entry.status).toBe(EntityStatus.NEW);
        expect(readEnqueuedData<ClientExpiredSessionsAppInboxPayload>(entry).atEpochMs).toBe(
            120_000,
        );

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        expect(expireExpiredSessions).toHaveBeenCalledTimes(2);
        expect(expireExpiredSessions).toHaveBeenLastCalledWith(120_000);
    });

    it('returns a left result when a client inbox mutation handler fails with a non-retryable error', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const service = new AppClientInboxService(
            reader,
            queue as never,
            results as never,
            createClientStateServiceStub({
                upsertPrincipal: vi.fn(async () => {
                    throw new NonRetryableException(
                        'Client principal update failed',
                    );
                }),
            }),
            createPublisher(),
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
        });

        expect(result.left).toBe('Client principal update failed');
    });
});

class TestResourceInbox extends InMemoryQueueBox {
    async isEntryWithStatus(
        key: Key,
        statuses: EntityStatus[],
    ): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }
}

function requireRightSnapshot(
    result: Either<string, ClientStateWritten>,
): ClientSnapshot {
    if (!result.right) {
        throw new Error(result.left ?? 'Expected client app-inbox right result');
    }

    return requireClientStateWrittenSnapshot(result.right);
}

function requireRightWritten(
    result: Either<string, ClientStateWritten>,
): ClientMutationWritten {
    if (!result.right) {
        throw new Error(result.left ?? 'Expected client app-inbox right result');
    }

    return requireClientMutationWritten(result.right);
}

function requireClientStateWrittenSnapshot(
    written: ClientStateWritten,
): ClientSnapshot {
    return requireClientMutationWritten(written).snapshot;
}

function requireClientMutationWritten(
    written: ClientStateWritten,
): ClientMutationWritten {
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

    async writeIfAbsentOrReplaceExpired(
        entry: ResourceEntry,
    ): Promise<ResourceEntry> {
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
    const resultPromise = service.processEntryUntilCompletion<V, R>(input);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    return await resultPromise;
}

async function processAppInboxMethod<R>(
    reader: InboxQueueReader,
    run: () => Promise<R>,
): Promise<R> {
    const resultPromise = run();
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    return await resultPromise;
}

async function waitForQueueEntryCount(
    queue: InMemoryQueueBox,
    count: number,
): Promise<void> {
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
        (await queue.getAllKeys()).map((key) => queue.getItem(key)),
    );

    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

function activeEntries(entries: ResourceEntry[]): ResourceEntry[] {
    const activeStatuses = new Set([
        EntityStatus.NEW,
        EntityStatus.RESERVED,
        EntityStatus.RETRY,
    ]);

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
    overrides: Partial<ClientStateService>,
): ClientStateService {
    return {
        listSnapshots: vi.fn(),
        readSnapshot: vi.fn(),
        readPresenceSnapshot: vi.fn(),
        listEvents: vi.fn(),
        upsertPrincipal: vi.fn(),
        upsertInstance: vi.fn(),
        connectSession: vi.fn(),
        heartbeatSession: vi.fn(),
        disconnectSession: vi.fn(),
        expireExpiredSessions: vi.fn(),
        registerAuthorisedWsClientSession: vi.fn(),
        disconnectAuthorisedWsClientSession: vi.fn(),
        ...overrides,
    } as unknown as ClientStateService;
}

function createPublisher() {
    return {
        publishClientSnapshot: vi.fn(
            async (_snapshot: unknown, _senderId?: string) => undefined,
        ),
        publishClientEvent: vi.fn(
            async (_event: unknown, _senderId?: string) => undefined,
        ),
        publishGroupSnapshot: vi.fn(
            async (_snapshot: unknown, _senderId?: string) => undefined,
        ),
        publishGroupEvent: vi.fn(
            async (_event: unknown, _senderId?: string) => undefined,
        ),
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
