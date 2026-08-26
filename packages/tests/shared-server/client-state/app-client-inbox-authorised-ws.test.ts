import { expect, it, vi } from 'vitest';

import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientMutationWritten, ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { toAuthorisedWsClientConnectEnqueue } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import type { AuthorisedWsClientMutationResult } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-result-codec.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import {
    createAppInboxTestResilience,
    TestResourceInbox,
    TestResourceInboxResults
} from '../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from '../rallar-system/app-inbox/test-support/app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../runtime-state/test-support/fake-runtime-state-repository.ts';

const SERVICE_ID = 'server-12345678';

it('rejects authorised websocket disconnect after durable auth revocation', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const authSession = issuedSession('alice', 'alice-ws-session');
    const runtimeRepository = new FakeRuntimeStateRepository();
    const authSessions = new AuthSessionRepository(runtimeRepository);
    await authSessions.putSession(authSession);
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const service = createAuthorisedWsService({
        database,
        queue,
        reader,
        results,
        runtimeRepository
    });

    const connectInput = {
        authSession,
        generationId: 'generation-1',
        input: {
            expiresAtEpochMs: Date.now() + 60_000,
            userAgent: 'Browser'
        }
    } as const;
    const connected = await processAppInboxMethod(queue, reader, () => service.processAuthorisedWsClientConnect(connectInput));
    await authSessions.deleteSession(authSession);
    const disconnected = await processAppInboxMethod(queue, reader, () =>
        service.processAuthorisedWsClientDisconnect({
            connection: toAuthorisedWsClientConnectEnqueue(connectInput).data,
            disconnectedAtEpochMs: Date.now(),
            reason: 'socket-closed'
        }));
    expect(disconnected.left).toMatchObject({
        type: 'app-inbox-failure',
        code: 'client-mutation-rejected',
        status: 400
    });

    expect(requireRightSnapshot(connected).activeSessions).toHaveLength(1);
    expect(requireRightSnapshot(connected).instances[0]).toMatchObject({
        clientInstanceId: 'alice',
        userAgent: 'Browser'
    });
    expect(requireRightSnapshot(connected).activeSessions).toHaveLength(1);
});

it('processes authorised websocket connects in the requested state scope', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const authSession = issuedSession('admin', 'admin-ws-session');
    const runtimeRepository = new FakeRuntimeStateRepository();
    await new AuthSessionRepository(runtimeRepository).putSession(authSession);
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const service = createAuthorisedWsService({
        database,
        queue,
        reader,
        results,
        runtimeRepository
    });

    const connected = await processAppInboxMethod(queue, reader, () =>
        service.processAuthorisedWsClientConnect({
            authSession,
            generationId: 'generation-admin',
            input: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                expiresAtEpochMs: Date.now() + 60_000,
                userAgent: 'Browser'
            }
        }));

    const snapshot = requireRightSnapshot(connected);
    expect(snapshot.principal).toMatchObject({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId: 'admin',
        username: 'admin'
    });
    expect(snapshot.instances[0]).toMatchObject({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        clientInstanceId: 'admin',
        userAgent: 'Browser'
    });
    expect(snapshot.activeSessions[0]).toMatchObject({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        clientInstanceId: 'admin',
        sessionId: 'admin-ws-session',
        transport: 'ws'
    });
});

it('processes authorised websocket connects independently per state scope', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const authSession = issuedSession('admin', 'admin-ws-session');
    const runtimeRepository = new FakeRuntimeStateRepository();
    await new AuthSessionRepository(runtimeRepository).putSession(authSession);
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const service = createAuthorisedWsService({
        database,
        queue,
        reader,
        results,
        runtimeRepository
    });

    const defaultConnect = await processAppInboxMethod(queue, reader, () =>
        service.processAuthorisedWsClientConnect({
            authSession,
            generationId: 'generation-default',
            input: {
                applicationId: 'rallar-server',
                workspaceId: 'default'
            }
        }));
    const scopedConnect = await processAppInboxMethod(queue, reader, () =>
        service.processAuthorisedWsClientConnect({
            authSession,
            generationId: 'generation-scoped',
            input: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default'
            }
        }));

    expect(requireRightSnapshot(defaultConnect).principal).toMatchObject({
        applicationId: 'rallar-server',
        workspaceId: 'default'
    });
    expect(requireRightSnapshot(scopedConnect).principal).toMatchObject({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default'
    });
});

it(
    [
        'disconnects authorised websocket sessions from their connected state scope',
        'while auth exists'
    ].join(' '),
    async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const authSession = issuedSession('admin', 'admin-ws-session');
        const runtimeRepository = new FakeRuntimeStateRepository();
        await new AuthSessionRepository(runtimeRepository).putSession(authSession);
        const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
        const service = createAuthorisedWsService({
            database,
            queue,
            reader,
            results,
            runtimeRepository
        });

        const connectInput = {
            authSession,
            generationId: 'generation-scoped',
            input: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                expiresAtEpochMs: Date.now() + 60_000
            }
        } as const;
        await processAppInboxMethod(queue, reader, () => service.processAuthorisedWsClientConnect(connectInput));
        const disconnected = await processAppInboxMethod(queue, reader, () =>
            service.processAuthorisedWsClientDisconnect({
                connection: toAuthorisedWsClientConnectEnqueue(connectInput).data,
                disconnectedAtEpochMs: Date.now(),
                reason: 'socket-closed'
            }));

        expect(requireRightSnapshot(disconnected).principal).toMatchObject({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: 'admin'
        });
        expect(requireRightSnapshot(disconnected).activeSessions).toHaveLength(0);
        expect(requireRightWritten(disconnected).event).toMatchObject({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            eventType: 'session-disconnected'
        });
    }
);

interface CreateAuthorisedWsServiceInput {
    readonly database: ReturnType<typeof createAppInboxTestDatabase>;
    readonly queue: TestResourceInbox;
    readonly reader: InboxQueueReader;
    readonly results: TestResourceInboxResults;
    readonly runtimeRepository: FakeRuntimeStateRepository;
}

function createAuthorisedWsService(input: CreateAuthorisedWsServiceInput): AppClientInboxService {
    return new AppClientInboxService(
        {
            inboxQueueReader: input.reader,
            resourceInboxRepository: input.queue,
            resourceInboxResultsRepository: input.results,
            database: input.database,
            clientStateService: createClientStateService({
                runtimeRepository: input.runtimeRepository,
                clientStateEventStore: input.database.clientEventStore,
                serviceId: SERVICE_ID
            })
        },
        {
            serviceId: SERVICE_ID
        }
    );
}

function requireRightSnapshot(
    result: Either<AppInboxFailure, AuthorisedWsClientMutationResult>
): ClientSnapshot {
    return requireRightWritten(result).snapshot;
}

function requireRightWritten(
    result: Either<AppInboxFailure, AuthorisedWsClientMutationResult>
): ClientMutationWritten {
    if (!result.right) {
        throw new Error(result.left?.message ?? 'Expected client app-inbox right result');
    }
    if (result.right.status === 'inactive') {
        throw new Error(`Expected client mutation result, received ${result.right.status}`);
    }
    return requireClientMutationWritten(result.right);
}

function requireClientMutationWritten(written: ClientStateWritten): ClientMutationWritten {
    return written.result;
}

function issuedSession(clientId: string, sessionId: string): IssuedAuthSession {
    const nowEpochMs = Date.now();
    return {
        clientId,
        accessToken: `${clientId}-token`,
        username: clientId,
        sessionId,
        issuedAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: nowEpochMs + 60_000
    };
}

async function processAppInboxMethod<Result>(
    queue: TestResourceInbox,
    reader: InboxQueueReader,
    run: () => Promise<Result>
): Promise<Result> {
    const minimumEntries = (await queue.getAllKeys()).length + 1;
    const resultPromise = run();
    await queue.waitForEntryCount(minimumEntries);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAppInboxTestResilience()
    );
    return await resultPromise;
}
