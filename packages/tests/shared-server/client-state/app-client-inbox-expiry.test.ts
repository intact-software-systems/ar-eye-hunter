import { expect, it, vi } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import {
    type ClientExpiredSessionsAppInboxPayload,
    type ClientSessionConnectAppInboxPayload
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { createAuthInboxTestResilience } from '../auth/auth-app-inbox-test-runtime.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
    ClientExpiryTestResourceInbox,
    ClientExpiryTestResourceInboxResults,
    createClientExpiryTestIssuedAuthority,
    listActiveClientExpiryTestEntries,
    readClientExpiryTestEnqueueData,
    readClientExpiryTestEntries
} from './app-client-inbox-expiry-fixtures.ts';
import { createClientStateServiceStub } from './app-client-inbox-mutation-test-harness.ts';
import { createClientStatePhaseTestDriver } from './client-state-test-runtime.ts';

const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

interface SeedClientExpirySessionInput {
    readonly expiresAtEpochMs: number;
    readonly runtimeRepository: FakeRuntimeStateRepository;
}

it(
    'processes expired client sessions through the inbox and publishes written mutations',
    async () => {
        const queue = new ClientExpiryTestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new ClientExpiryTestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const expiresAtEpochMs = Date.now() - 1_000;
        const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
        const clientStateService = createClientStateService({
            runtimeRepository,
            clientStateEventStore: database.clientEventStore,
            serviceId: 'server-12345678'
        });
        const service = new AppClientInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: database,
                clientStateService: clientStateService
            },
            {
                serviceId: 'server-12345678'
            }
        );
        await seedClientExpirySession(service, reader, { expiresAtEpochMs, runtimeRepository });

        const expired = await processClientInbox(
            queue,
            reader,
            () => service.processExpiredSessions(expiresAtEpochMs + 1)
        );

        expect(expired.right).toHaveLength(1);
        expect(expired.right?.[0].result?.event).toMatchObject({
            eventType: 'session-expired',
            reason: 'expired',
            sessionId: 'alice-session'
        });
        expect(expired.right?.[0].result?.snapshot.activeSessions).toEqual([]);
    }
);

it('keeps at most one active waiting client expiry entry across timestamps', async () => {
    const queue = new ClientExpiryTestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new ClientExpiryTestResourceInboxResults();
    const expiryCandidateReads: number[] = [];
    const listExpiredSessionCandidates = async (atEpochMs: number) => {
        expiryCandidateReads.push(atEpochMs);
        return [];
    };
    const service = new AppClientInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: createAppInboxTestDatabase(queue, results),
            clientStateService: createClientStateServiceStub({ listExpiredSessionCandidates })
        },
        {
            serviceId: 'server-12345678'
        }
    );

    const first = service.processExpiredSessions(60_000);
    const second = service.processExpiredSessions(120_000);

    await waitForQueueEntryCount(queue, 1);
    const entries = await readClientExpiryTestEntries(queue);

    expect(listActiveClientExpiryTestEntries(entries)).toHaveLength(1);
    expect(entries[0].key.resourceId).toBe('expire-client-sessions');
    expect(
        readClientExpiryTestEnqueueData<ClientExpiredSessionsAppInboxPayload>(entries[0]).atEpochMs
    ).toBe(60_000);

    await dequeueClientInbox(reader);

    await expect(first).resolves.toMatchObject({ right: [] });
    await expect(second).resolves.toMatchObject({ right: [] });
    expect(expiryCandidateReads).toEqual([60_000]);
});

it('durably enqueues each client expiry reconciliation tick', async () => {
    const queue = new ClientExpiryTestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new ClientExpiryTestResourceInboxResults();
    const expiryCandidateReads: number[] = [];
    const listExpiredSessionCandidates = async (atEpochMs: number) => {
        expiryCandidateReads.push(atEpochMs);
        return [];
    };
    const service = new AppClientInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: createAppInboxTestDatabase(queue, results),
            clientStateService: createClientStateServiceStub({ listExpiredSessionCandidates })
        },
        {
            serviceId: 'server-12345678'
        }
    );

    const first = await service.enqueueExpiredSessions(60_000);
    const second = await service.enqueueExpiredSessions(120_000);
    expect(first.key.resourceId).toBe('expire-client-sessions-60000');
    expect(second.key.resourceId).toBe('expire-client-sessions-120000');
    expect(await readClientExpiryTestEntries(queue)).toHaveLength(2);
    expect(expiryCandidateReads).toEqual([]);
});

it('expires stale sessions once and leaves publication to the app inbox', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedConnectedSession(runtimeRepository, expiresAtEpochMs);

    const now = expiresAtEpochMs + 1;
    const service = createClientStatePhaseTestDriver(runtimeRepository, () => now);
    const principalRef = toClientPrincipalRef('alice');

    const first = await service.expireExpiredSessions(now);
    const second = await service.expireExpiredSessions(now);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(first[0].result?.event).toMatchObject({
        eventType: 'session-expired',
        reason: 'expired',
        sessionId: 'session-1'
    });
    expect(first[0].result?.snapshot).toMatchObject({
        principal: { snapshotVersion: 2, presenceVersion: 2 },
        activeSessions: [],
        isOnline: false
    });

    const repository = createTestClientStateRepository(runtimeRepository);
    expect(
        await repository.findSession({
            ...principalRef,
            clientInstanceId: 'alice-browser',
            sessionId: 'session-1'
        })
    ).toMatchObject({
        status: 'expired',
        disconnectReason: 'expired',
        disconnectedAtEpochMs: expiresAtEpochMs
    });
    expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
        'session-connected',
        'session-expired'
    ]);
});

it('does not rewrite an expired session when a late disconnect cleanup arrives', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedConnectedSession(runtimeRepository, expiresAtEpochMs);
    runtimeRepository.locks.splice(0);

    const now = expiresAtEpochMs + 1;
    const service = createClientStatePhaseTestDriver(runtimeRepository, () => now);
    const principalRef = toClientPrincipalRef('alice');

    await service.expireExpiredSessions(now);
    const lateDisconnect = await service.disconnectSession(
        SCOPE,
        principalRef.principalId,
        'alice-browser',
        'session-1',
        {
            generationId: 'generation-session-1',
            reason: 'socket-closed',
            actorPrincipalId: 'alice',
            actorSessionId: 'session-1',
            requestId: 'late-disconnect-after-expiry'
        }
    );

    expect(lateDisconnect.result?.event).toBeNull();
    const repository = createTestClientStateRepository(runtimeRepository);
    expect(
        await repository.findSession({
            ...principalRef,
            clientInstanceId: 'alice-browser',
            sessionId: 'session-1'
        })
    ).toMatchObject({
        status: 'expired',
        disconnectReason: 'expired',
        disconnectedAtEpochMs: expiresAtEpochMs
    });
    expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
        'session-connected',
        'session-expired'
    ]);
    expect(runtimeRepository.locks).toEqual([]);
});

it('ignores a late heartbeat from an expired connection generation', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedConnectedSession(runtimeRepository, expiresAtEpochMs);

    const now = expiresAtEpochMs + 1;
    const service = createClientStatePhaseTestDriver(runtimeRepository, () => now);
    const principalRef = toClientPrincipalRef('alice');

    await service.expireExpiredSessions(now);
    const lateHeartbeat = await service.heartbeatSession(
        SCOPE,
        principalRef.principalId,
        'alice-browser',
        'session-1',
        {
            generationId: 'generation-session-1',
            presenceState: 'online',
            actorPrincipalId: 'alice',
            actorSessionId: 'session-1',
            lastHeartbeatAtEpochMs: now + 1,
            expiresAtEpochMs: now + 60_000,
            requestId: 'late-heartbeat-after-expiry'
        }
    );

    expect(lateHeartbeat.result?.event).toBeNull();
    expect(lateHeartbeat.result?.snapshot.activeSessions).toHaveLength(0);

    const repository = createTestClientStateRepository(runtimeRepository);
    expect(
        await repository.findSession({
            ...principalRef,
            clientInstanceId: 'alice-browser',
            sessionId: 'session-1'
        })
    ).toMatchObject({ status: 'expired', disconnectReason: 'expired' });
    expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
        'session-connected',
        'session-expired'
    ]);
});

async function seedClientExpirySession(
    service: AppClientInboxService,
    reader: InboxQueueReader,
    input: SeedClientExpirySessionInput
): Promise<void> {
    const authority = await createClientExpiryTestIssuedAuthority(
        input.runtimeRepository,
        'alice',
        'alice-session'
    );
    const seeded = service.processAuthenticatedEntryUntilCompletion(
        {
            type: AppInboxType.CLIENT_SESSION_CONNECT,
            topicId: AppInboxType.CLIENT_SESSION_CONNECT,
            resourceId: 'seed-client-expiry-session',
            contextId: toAuthenticatedClientMutationContextId({
                scope: SCOPE,
                principalId: 'alice',
                callerClientId: authority.clientId,
                callerSessionId: authority.sessionId
            }),
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
                    connectedAtEpochMs: input.expiresAtEpochMs - 2_000,
                    lastHeartbeatAtEpochMs: input.expiresAtEpochMs - 1_000,
                    expiresAtEpochMs: input.expiresAtEpochMs,
                    requestId: 'seed-client-expiry-session'
                }
            }
        },
        authority
    );
    await dequeueClientInbox(reader);
    await seeded;
}

async function processClientInbox<R>(
    queue: ClientExpiryTestResourceInbox,
    reader: InboxQueueReader,
    run: () => Promise<R>
): Promise<R> {
    const minimumEntries = (await readClientExpiryTestEntries(queue)).length + 1;
    const pending = run();
    await waitForQueueEntryCount(queue, minimumEntries);
    await dequeueClientInbox(reader);
    return await pending;
}

async function dequeueClientInbox(reader: InboxQueueReader): Promise<void> {
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAuthInboxTestResilience()
    );
}

async function waitForQueueEntryCount(
    queue: ClientExpiryTestResourceInbox,
    count: number
): Promise<void> {
    await vi.waitFor(async () => {
        expect((await readClientExpiryTestEntries(queue)).length).toBeGreaterThanOrEqual(count);
    }, { timeout: 2_000 });
}

async function seedConnectedSession(
    runtimeRepository: FakeRuntimeStateRepository,
    expiresAtEpochMs: number
): Promise<void> {
    const now = Math.max(2_000, expiresAtEpochMs - 1_000);
    await createClientStatePhaseTestDriver(runtimeRepository, () => now).connectSession(
        SCOPE,
        'alice',
        'alice-browser',
        'session-1',
        {
            generationId: 'generation-session-1',
            presenceState: 'online',
            actorPrincipalId: 'alice',
            actorSessionId: 'session-1',
            connectedAtEpochMs: 2_000,
            lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
            expiresAtEpochMs,
            requestId: 'seed-session-1'
        }
    );
}

function toClientPrincipalRef(principalId: string): ClientPrincipalRef {
    return { ...SCOPE, principalId };
}
