import { describe, expect, it, vi } from 'vitest';

import type {
    ClientInstanceUpsertAppInboxPayload,
    ClientPrincipalUpsertAppInboxPayload,
    ClientSessionConnectAppInboxPayload,
    ClientSessionDisconnectAppInboxPayload,
    ClientSessionHeartbeatAppInboxPayload
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { AppInboxHandlerRegistry } from '@shared-server/rallar-system/app-inbox/app-inbox-handler-registry.ts';
import { AppInboxQueueClient, AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import type { ClientStateService, ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
    CLIENT_STATE_TEST_SCOPE as SCOPE,
    createAutoAuthorizingClientStateService,
    createClientStateServiceStub,
    processAppInbox,
    requireRightSnapshot
} from './app-client-inbox-mutation-test-harness.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';

describe('AppClientInbox operation matrix', () => {
    it('registers the established eight client mutation families in order', () => {
        const registration = vi
            .spyOn(AppInboxHandlerRegistry.prototype, 'onStateMessage')
            .mockImplementation(() => undefined);
        try {
            createClientInboxServiceForRegistration();

            expect(registration.mock.calls.map(([type]) => type)).toEqual([
                AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                AppInboxType.CLIENT_INSTANCE_UPSERT,
                AppInboxType.CLIENT_SESSION_CONNECT,
                AppInboxType.CLIENT_SESSION_HEARTBEAT,
                AppInboxType.CLIENT_SESSION_DISCONNECT,
                AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
                AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
                AppInboxType.CLIENT_EXPIRED_SESSIONS
            ]);
        }
        finally {
            registration.mockRestore();
        }
    });
});

function createClientInboxServiceForRegistration(): AppClientInboxService {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    return new AppClientInboxService(
        {
            inboxQueueReader: new InboxQueueReader(queue),
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: createAppInboxTestDatabase(queue, results),
            clientStateService: createClientStateServiceStub()
        },
        {
            serviceId: 'client-registration-service'
        }
    );
}

describe('AppClientInbox mutation processing', () => {
    it('processes principal, instance, and session mutations through the inbox', async () => {
        const harness = createMutationProcessingHarness();
        const principal = await upsertPrincipal(harness);
        const instance = await upsertInstance(harness);
        const connected = await connectSession(harness);
        const heartbeat = await heartbeatSession(harness);
        const disconnected = await disconnectSession(harness);

        expectMutationProcessingResults(harness, {
            principal,
            instance,
            connected,
            heartbeat,
            disconnected
        });
    });

    it(
        'returns a left result when a client inbox mutation handler fails ' +
            'with a non-retryable error',
        async () => {
            const queue = new TestResourceInbox();
            const reader = new InboxQueueReader(queue);
            const results = new TestResourceInboxResults();
            const service = new AppClientInboxService(
                {
                    inboxQueueReader: reader,
                    resourceInboxRepository: queue,
                    resourceInboxResultsRepository: results,
                    database: createAppInboxTestDatabase(queue, results),
                    clientStateService: createClientStateServiceStub({
                        read: vi.fn(async () => {
                            throw new NonRetryableException('Client principal update failed');
                        })
                    })
                },
                {
                    serviceId: 'server-12345678'
                }
            );

            const result = await processAppInbox<ClientPrincipalUpsertAppInboxPayload>(service, reader, {
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
                        requestId: 'upsert-client-fail'
                    }
                }
            });

            expect(result.left).toMatchObject({
                code: 'app-inbox-non-retryable',
                status: 400,
                message: 'Client principal update failed'
            });
        }
    );
});

function createMutationProcessingHarness() {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    return {
        connectedAtEpochMs: Date.now(),
        reader,
        service: new AppClientInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: database,
                clientStateService: createAutoAuthorizingClientStateService(runtimeRepository, database)
            },
            {
                serviceId: 'server-12345678'
            }
        )
    };
}

type MutationProcessingHarness = ReturnType<typeof createMutationProcessingHarness>;

function upsertPrincipal(harness: MutationProcessingHarness) {
    return processAppInbox<ClientPrincipalUpsertAppInboxPayload>(harness.service, harness.reader, {
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
                requestId: 'upsert-client-alice'
            }
        }
    });
}

function upsertInstance(harness: MutationProcessingHarness) {
    return processAppInbox<ClientInstanceUpsertAppInboxPayload>(harness.service, harness.reader, {
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
                requestId: 'upsert-client-alice-instance'
            }
        }
    });
}

function connectSession(harness: MutationProcessingHarness) {
    return processAppInbox<ClientSessionConnectAppInboxPayload>(harness.service, harness.reader, {
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
                connectedAtEpochMs: harness.connectedAtEpochMs,
                lastHeartbeatAtEpochMs: harness.connectedAtEpochMs,
                expiresAtEpochMs: harness.connectedAtEpochMs + 60_000,
                requestId: 'connect-client-alice-session'
            }
        }
    });
}

function heartbeatSession(harness: MutationProcessingHarness) {
    return processAppInbox<ClientSessionHeartbeatAppInboxPayload>(harness.service, harness.reader, {
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
                lastHeartbeatAtEpochMs: harness.connectedAtEpochMs + 1,
                expiresAtEpochMs: harness.connectedAtEpochMs + 60_001,
                requestId: 'heartbeat-client-alice-session'
            }
        }
    });
}

function disconnectSession(harness: MutationProcessingHarness) {
    return processAppInbox<ClientSessionDisconnectAppInboxPayload>(harness.service, harness.reader, {
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
                requestId: 'disconnect-client-alice-session'
            }
        }
    });
}

interface MutationProcessingResults {
    readonly principal: Either<AppInboxFailure, ClientStateWritten>;
    readonly instance: Either<AppInboxFailure, ClientStateWritten>;
    readonly connected: Either<AppInboxFailure, ClientStateWritten>;
    readonly heartbeat: Either<AppInboxFailure, ClientStateWritten>;
    readonly disconnected: Either<AppInboxFailure, ClientStateWritten>;
}

function expectMutationProcessingResults(
    harness: MutationProcessingHarness,
    results: MutationProcessingResults
): void {
    expect(requireRightSnapshot(results.principal).principal.displayName).toBe('Alice');
    expect(requireRightSnapshot(results.instance).instances[0]).toMatchObject({
        clientInstanceId: 'alice-browser',
        platform: 'web'
    });
    expect(requireRightSnapshot(results.connected).activeSessions).toHaveLength(1);
    expect(requireRightSnapshot(results.heartbeat).activeSessions[0]).toMatchObject({
        sessionId: 'alice-session',
        presenceState: 'away',
        lastHeartbeatAtEpochMs: harness.connectedAtEpochMs + 1
    });
    expect(requireRightSnapshot(results.disconnected).activeSessions).toHaveLength(0);
}
