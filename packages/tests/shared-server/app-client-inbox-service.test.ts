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

        const connected = await processAppInboxMethod(reader, () =>
            service.processAuthorisedWsClientConnect(authSession, {
                expiresAtEpochMs: Date.now() + 60_000,
                userAgent: 'Browser',
            })
        );
        vi.mocked(publisher.publishClientSnapshot).mockClear();
        vi.mocked(publisher.publishClientEvent).mockClear();
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
        registerAuthorisedWsClientSession: vi.fn(),
        disconnectAuthorisedWsClientSession: vi.fn(),
        ...overrides,
    } as unknown as ClientStateService;
}

function createPublisher() {
    return {
        publishClientSnapshot: vi.fn(async () => undefined),
        publishClientEvent: vi.fn(async () => undefined),
        publishGroupSnapshot: vi.fn(async () => undefined),
        publishGroupEvent: vi.fn(async () => undefined),
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
