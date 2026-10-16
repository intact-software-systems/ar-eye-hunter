import { expect, it } from 'vitest';

import { AppInboxType, toAppInboxCompletionAwaitability } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientMutationWritten, ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import {
    toAuthorisedWsClientConnection,
    type ToAuthorisedWsClientConnectionInput
} from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import {
    decodeAuthorisedWsClientMutationResult,
    type AuthorisedWsClientMutationResult
} from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-result-codec.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestResilience, TestResourceInbox, TestResourceInboxResults } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { readCompletedAppInboxResult } from '../app-inbox/test-support/read-completed-app-inbox-result.ts';
import { putAuthorisedWsTestTicket } from './authorised-ws-test-ticket.ts';

const SERVICE_ID = 'server-12345678';

it('awaits only the authorised websocket connect, which its upgrade route waits for', () => {
    // A cross-server relay never notifies a fire-and-forget completion, so a waiter on one
    // would return only on its safety tick; production enqueues these types without waiting.
    for (const name of ['processAuthorisedWsClientConnect', 'processAuthorisedWsClientDisconnect', 'processExpiredSessions']) {
        expect(Reflect.get(AppClientInboxService.prototype, name), name).toBeUndefined();
    }
    for (const type of [AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT, AppInboxType.CLIENT_EXPIRED_SESSIONS]) {
        expect(toAppInboxCompletionAwaitability(type), type).toBe('fire-and-forget');
    }
    expect(toAppInboxCompletionAwaitability(AppInboxType.CLIENT_AUTHORISED_WS_CONNECT)).toBe('awaitable');
});

it('consumes the upgrade ticket in the connect transaction so a replayed ticket is rejected and writes nothing', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
    const results = new TestResourceInboxResults();
    const authSession = issuedSession('alice', 'alice-ws-session');
    const runtimeRepository = new FakeRuntimeStateRepository();
    const authSessions = new AuthSessionRepository(runtimeRepository);
    await authSessions.putSession(authSession);
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const service = createAuthorisedWsService({ database, queue, reader, results, runtimeRepository });
    const ticketDigest = await putAuthorisedWsTestTicket(authSessions, authSession);

    const connects = [
        service.writeAuthorisedWsClientConnect({ authSession, generationId: 'generation-1', ticketDigest }),
        service.writeAuthorisedWsClientConnect({ authSession, generationId: 'generation-2', ticketDigest })
    ];
    await queue.waitForEntryCount(2);
    const [first, replay] = await drainUntilSettled(reader, connects);

    const outcomes = [first, replay].map((result) => result.right?.status).toSorted();
    expect(outcomes).toEqual(['ok', 'ticket-rejected']);
    expect(await authSessions.readWebSocketTicketByDigestEntry(ticketDigest)).toEqual({
        value: undefined,
        expiredEntry: undefined
    });
    const snapshot = await createClientStateService({
        runtimeRepository,
        clientStateEventStore: database.clientEventStore,
        serviceId: SERVICE_ID
    }).readSnapshot({ applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID, principalId: 'alice' });
    expect(snapshot?.activeSessions).toHaveLength(1);
});

it('rejects authorised websocket disconnect after durable auth revocation', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
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
    const connected = await connectAuthorisedWs({ queue, reader, service }, {
        ...connectInput,
        ticketDigest: await putAuthorisedWsTestTicket(authSessions, authSession)
    });
    await authSessions.deleteSession(authSession);
    const disconnected = await drainAuthorisedWsEntry({ queue, reader, results }, () =>
        service.enqueueAuthorisedWsClientDisconnect({
            connection: toAuthorisedWsClientConnection(connectInput),
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

it('serves an authorised websocket disconnect after its own connect behind a backlog of the principal', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const service = createAuthorisedWsService({ database, queue, reader, results, runtimeRepository });
    const backlog = ['alice-tab-1', 'alice-tab-2', 'alice-tab-3'].map((sessionId) => issuedSession('alice', sessionId));
    const closing = issuedSession('alice', 'alice-closing-tab');
    for (const session of [...backlog, closing]) {
        await authSessions.putSession(session);
    }
    const backlogConnects = [];
    for (const session of backlog) {
        backlogConnects.push(service.writeAuthorisedWsClientConnect({
            authSession: session,
            generationId: 'generation-1',
            ticketDigest: await putAuthorisedWsTestTicket(authSessions, session)
        }));
    }
    const closingConnect = { authSession: closing, generationId: 'generation-1' } as const;
    const closingConnected = service.writeAuthorisedWsClientConnect({
        ...closingConnect,
        ticketDigest: await putAuthorisedWsTestTicket(authSessions, closing)
    });
    await queue.waitForEntryCount(backlog.length + 1);
    const connect = requireQueuedConnect(await queue.readEntries(), closing.sessionId);
    const disconnect = await service.enqueueAuthorisedWsClientDisconnect({
        connection: toAuthorisedWsClientConnection(closingConnect),
        disconnectedAtEpochMs: Date.now(),
        reason: 'socket-closed'
    });

    const completedInPass = new Map<string, number>();
    for (let pass = 1; await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience()) > 0; pass += 1) {
        for (const entry of [connect, disconnect]) {
            if ((await queue.getItem(entry.key))?.status === EntityStatus.COMPLETED && !completedInPass.has(entry.key.resourceId)) {
                completedInPass.set(entry.key.resourceId, pass);
            }
        }
    }

    expect(completedInPass.get(disconnect.key.resourceId)).toBeGreaterThan(completedInPass.get(connect.key.resourceId) ?? Number.POSITIVE_INFINITY);
    expect((await Promise.all([...backlogConnects, closingConnected])).map((result) => result.right?.status)).toEqual([
        'ok',
        'ok',
        'ok',
        'ok'
    ]);
    const snapshot = await createClientStateService({
        runtimeRepository,
        clientStateEventStore: database.clientEventStore,
        serviceId: SERVICE_ID
    }).readSnapshot({ applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID, principalId: 'alice' });
    expect(snapshot?.activeSessions.map((session) => session.sessionId).toSorted()).toEqual(['alice-tab-1', 'alice-tab-2', 'alice-tab-3']);
});

it('processes authorised websocket connects in the requested state scope', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
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

    const connected = await connectAuthorisedWs({ queue, reader, service }, {
        authSession,
        generationId: 'generation-admin',
        ticketDigest: await putAuthorisedWsTestTicket(new AuthSessionRepository(runtimeRepository), authSession),
        input: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            expiresAtEpochMs: Date.now() + 60_000,
            userAgent: 'Browser'
        }
    });

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
    const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
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

    const authSessions = new AuthSessionRepository(runtimeRepository);
    const defaultConnect = await connectAuthorisedWs({ queue, reader, service }, {
        authSession,
        generationId: 'generation-default',
        ticketDigest: await putAuthorisedWsTestTicket(authSessions, authSession, 'default-ticket'),
        input: {
            applicationId: 'rallar-server',
            workspaceId: 'default'
        }
    });
    const scopedConnect = await connectAuthorisedWs({ queue, reader, service }, {
        authSession,
        generationId: 'generation-scoped',
        ticketDigest: await putAuthorisedWsTestTicket(authSessions, authSession, 'scoped-ticket'),
        input: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default'
        }
    });

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
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
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
        await connectAuthorisedWs({ queue, reader, service }, {
            ...connectInput,
            ticketDigest: await putAuthorisedWsTestTicket(new AuthSessionRepository(runtimeRepository), authSession)
        });
        const disconnected = await drainAuthorisedWsEntry({ queue, reader, results }, () =>
            service.enqueueAuthorisedWsClientDisconnect({
                connection: toAuthorisedWsClientConnection(connectInput),
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
            }),
            wsTickets: new AuthSessionRepository(input.runtimeRepository)
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
    if (result.right.status !== 'ok') {
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

interface AuthorisedWsTestQueue {
    readonly queue: TestResourceInbox;
    readonly reader: InboxQueueReader;
    readonly results: TestResourceInboxResults;
}

async function drainAuthorisedWsEntry(
    { queue, reader, results }: AuthorisedWsTestQueue,
    enqueue: () => Promise<ResourceEntry>
): Promise<Either<AppInboxFailure, AuthorisedWsClientMutationResult>> {
    const entry = await enqueue();
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience());
    return await readCompletedAppInboxResult({
        statusRepository: queue,
        resultRepository: results,
        entry,
        decodeResult: decodeAuthorisedWsClientMutationResult
    });
}

interface AuthorisedWsConnectQueue {
    readonly queue: TestResourceInbox;
    readonly reader: InboxQueueReader;
    readonly service: AppClientInboxService;
}

/** Drains the queue while the connect waits for its result, as the upgrade route does. */
async function connectAuthorisedWs(
    { queue, reader, service }: AuthorisedWsConnectQueue,
    input: ToAuthorisedWsClientConnectionInput & Readonly<{ ticketDigest: string; }>
): Promise<Either<AppInboxFailure, AuthorisedWsClientMutationResult>> {
    const queuedBefore = (await queue.readEntries()).length;
    const connected = service.writeAuthorisedWsClientConnect(input);
    await queue.waitForEntryCount(queuedBefore + 1);
    const [result] = await drainUntilSettled(reader, [connected]);
    return result!;
}

/** One pass at a time, retries included, until every waiting connect has its result. */
async function drainUntilSettled<T>(reader: InboxQueueReader, pending: readonly Promise<T>[]): Promise<T[]> {
    let settled = false;
    const all = Promise.all(pending).finally(() => {
        settled = true;
    });
    while (!settled) {
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience());
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return await all;
}

function requireQueuedConnect(entries: readonly ResourceEntry[], sessionId: string): ResourceEntry {
    const entry = entries.find((candidate) => candidate.resource.includes('CLIENT_AUTHORISED_WS_CONNECT') && candidate.resource.includes(sessionId));
    if (entry === undefined) {
        throw new Error(`Expected a queued connect for ${sessionId}`);
    }
    return entry;
}
