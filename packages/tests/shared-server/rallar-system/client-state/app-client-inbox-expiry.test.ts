import { expect, it, vi } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { decodePersistedAppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure-decoding.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import type { ClientExpiredSessionsAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import * as ClientMutationComputation from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import {
    ClientExpiryTestResourceInbox,
    ClientExpiryTestResourceInboxResults,
    createClientExpiryTestIssuedAuthority,
    listActiveClientExpiryTestEntries,
    readClientExpiryTestEnqueueData,
    readClientExpiryTestEntries
} from './app-client-inbox-expiry-fixtures.ts';
import { createClientStateServiceStub } from './client-state-service-stub.ts';
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

it('reads the entire expiry batch before compute and emits per-item phase and commit timing', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const expiresAtEpochMs = Date.now() - 1_000;
    const seed = createClientStatePhaseTestDriver(runtimeRepository, () => expiresAtEpochMs - 1_000);
    for (const principalId of ['alice', 'bob']) {
        await seed.connectSession(SCOPE, principalId, `${principalId}-browser`, `${principalId}-session`, {
            generationId: `generation-${principalId}`,
            presenceState: 'online',
            actorPrincipalId: principalId,
            actorSessionId: `${principalId}-session`,
            connectedAtEpochMs: expiresAtEpochMs - 2_000,
            lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
            expiresAtEpochMs,
            requestId: `seed-${principalId}`
        });
    }
    const queue = new ClientExpiryTestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new ClientExpiryTestResourceInboxResults();
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const clientStateService = createClientStateService({ runtimeRepository, clientStateEventStore: database.clientEventStore, serviceId: 'server-12345678' });
    let computing = false;
    let elapsedMs = 0;
    const timingEvents: RallarTimingEvent[] = [];
    const service = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: queue,
        resourceInboxResultsRepository: results,
        database,
        clientStateService: {
            ...clientStateService,
            mutationTiming: {
                serviceId: 'original-client-service',
                sink: (event) => {
                    timingEvents.push(event);
                }
            },
            read: async (command) => {
                if (computing) {
                    throw new TypeError('Client expiry performed a repository read after compute began');
                }
                return await clientStateService.read(command);
            }
        }
    }, { serviceId: 'server-12345678' });

    const canonicalCompute = ClientMutationComputation.computeClientMutation;
    const compute = vi.spyOn(ClientMutationComputation, 'computeClientMutation').mockImplementation((input) => {
        computing = true;
        elapsedMs += input.command.aggregateRef.principalId === 'alice' ? 7 : 11;
        return canonicalCompute(input);
    });
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    try {
        const expired = await processClientInbox(queue, reader, () => service.processExpiredSessions(expiresAtEpochMs + 1));

        expect(expired.left).toBeUndefined();
        expect(expired.right).toHaveLength(2);
        expect(expired.right?.map((result) => result.result?.snapshot.activeSessions)).toEqual([[], []]);
        expect(timingEvents.map((event) => [event.operation, event.principalId, event.durationMs])).toEqual([
            ['mutation.compute', 'alice', 7],
            ['mutation.compute', 'bob', 11],
            ['mutation.validate', 'alice', 0],
            ['mutation.validate', 'bob', 0],
            ['mutation.write', 'alice', 0],
            ['mutation.write', 'bob', 0]
        ]);
        expect(timingEvents.every((event) => event.serviceId === 'original-client-service')).toBe(true);
    }
    finally {
        compute.mockRestore();
        clock.mockRestore();
    }
});

it('expires multiple sessions of one principal without conflicting with its own batch', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedClientExpiryBatch(runtimeRepository, expiresAtEpochMs);
    const queue = new ClientExpiryTestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new ClientExpiryTestResourceInboxResults();
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const clientStateService = createClientStateService({
        runtimeRepository,
        clientStateEventStore: database.clientEventStore,
        serviceId: 'server-12345678'
    });
    const service = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: queue,
        resourceInboxResultsRepository: results,
        database,
        clientStateService
    }, { serviceId: 'server-12345678' });

    const entry = await service.enqueueExpiredSessions(expiresAtEpochMs + 1);
    await dequeueClientInbox(reader);

    expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
    expect(await clientStateService.listExpiredSessionCandidates(expiresAtEpochMs + 1)).toEqual([]);
    expect(await clientStateService.readSnapshot(toClientPrincipalRef('alice'))).toMatchObject({
        stateRevision: 4,
        activeSessions: [],
        isOnline: false
    });
    expect(
        (await clientStateService.listEvents(toClientPrincipalRef('alice')))
            .filter((event) => event.eventType === 'session-expired')
            .map((event) => ({ sessionId: event.sessionId, snapshotVersion: event.snapshotVersion }))
    )
        .toEqual([
            { sessionId: 'alice-first', snapshotVersion: 3 },
            { sessionId: 'alice-second', snapshotVersion: 4 }
        ]);
});

it('rolls back the expiry batch on a later session conflict and rereads on queue redelivery', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedClientExpiryBatch(runtimeRepository, expiresAtEpochMs);
    const queue = new ClientExpiryTestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new ClientExpiryTestResourceInboxResults();
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const clientStateService = createClientStateService({
        runtimeRepository,
        clientStateEventStore: database.clientEventStore,
        serviceId: 'server-12345678'
    });
    const service = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: queue,
        resourceInboxResultsRepository: results,
        database,
        clientStateService
    }, { serviceId: 'server-12345678' });
    let injectedConflict = false;
    runtimeRepository.beforeConditionalWrite = (_operation, namespace, key) => {
        if (injectedConflict || namespace !== 'client-state:sessions' || !key.endsWith('session=alice-second')) {
            return;
        }
        const current = runtimeRepository.data.get(`${namespace}::${key}`);
        if (!current) {
            throw new Error('Expected the seeded second session');
        }
        injectedConflict = true;
        runtimeRepository.data.set(`${namespace}::${key}`, { ...current, revision: current.revision + 1 });
    };

    const entry = await service.enqueueExpiredSessions(expiresAtEpochMs + 1);
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(1_000));

    expect(injectedConflict).toBe(true);
    expect(await queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    expect(await clientStateService.readSnapshot(toClientPrincipalRef('alice'))).toMatchObject({ stateRevision: 2 });
    expect(await clientStateService.listEvents(toClientPrincipalRef('alice'))).toEqual([]);
    expect(database.outboxEntries.size).toBe(0);
    expect(await results.findByKey(entry.key)).toBeUndefined();

    await createClientStatePhaseTestDriver(runtimeRepository, () => expiresAtEpochMs).heartbeatSession(
        SCOPE,
        'alice',
        'alice-second-browser',
        'alice-second',
        {
            generationId: 'generation-alice-second',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-second',
            lastHeartbeatAtEpochMs: expiresAtEpochMs,
            expiresAtEpochMs: expiresAtEpochMs + 60_000,
            requestId: 'refresh-second-before-redelivery'
        }
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await dequeueClientInbox(reader);

    expect(await queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });
    expect(
        (await clientStateService.readSnapshot(toClientPrincipalRef('alice')))?.activeSessions
            .map((session) => session.sessionId)
    ).toEqual(['alice-second']);
    expect((await clientStateService.listEvents(toClientPrincipalRef('alice')))
        .map((event) => ({ sessionId: event.sessionId, eventType: event.eventType })))
        .toEqual([{ sessionId: 'alice-first', eventType: 'session-expired' }]);
});

it('rejects a mixed principal read before opening the expiry transaction', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedClientExpiryBatch(runtimeRepository, expiresAtEpochMs);
    const refresher = createClientStatePhaseTestDriver(runtimeRepository, () => expiresAtEpochMs);
    const queue = new ClientExpiryTestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new ClientExpiryTestResourceInboxResults();
    let transactionCount = 0;
    const database = createAppInboxTestDatabase(queue, results, {
        runtimeRepository,
        withTransaction: async (write) => {
            transactionCount += 1;
            return await write();
        }
    });
    const clientStateService = createClientStateService({
        runtimeRepository,
        clientStateEventStore: database.clientEventStore,
        serviceId: 'server-12345678'
    });
    let refreshed = false;
    const service = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: queue,
        resourceInboxResultsRepository: results,
        database,
        clientStateService: {
            ...clientStateService,
            read: async (command) => {
                const read = await clientStateService.read(command);
                if (!refreshed) {
                    refreshed = true;
                    await refresher.heartbeatSession(SCOPE, 'alice', 'alice-second-browser', 'alice-second', {
                        generationId: 'generation-alice-second',
                        actorPrincipalId: 'alice',
                        actorSessionId: 'alice-second',
                        lastHeartbeatAtEpochMs: expiresAtEpochMs,
                        expiresAtEpochMs: expiresAtEpochMs + 60_000,
                        requestId: 'refresh-between-expiry-reads'
                    });
                }
                return read;
            }
        }
    }, { serviceId: 'server-12345678' });

    const entry = await service.enqueueExpiredSessions(expiresAtEpochMs + 1);
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(1_000));

    expect(transactionCount).toBe(0);
    expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.RETRY);
    expect(
        (await clientStateService.readSnapshot(toClientPrincipalRef('alice')))?.activeSessions
            .map((session) => session.sessionId)
    ).toEqual(['alice-second']);
    expect(await clientStateService.listEvents(toClientPrincipalRef('alice'))).toEqual([]);
    expect(database.outboxEntries.size).toBe(0);
    expect(await results.findByKey(entry.key)).toBeUndefined();
});

it.each(['snapshot', 'principal'] as const)(
    'rejects an invalid original %s instead of hiding it behind the computed predecessor',
    async (field) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const expiresAtEpochMs = Date.now() - 1_000;
        await seedClientExpiryBatch(runtimeRepository, expiresAtEpochMs);
        const queue = new ClientExpiryTestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new ClientExpiryTestResourceInboxResults();
        const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
        const clientStateService = createClientStateService({
            runtimeRepository,
            clientStateEventStore: database.clientEventStore,
            serviceId: 'server-12345678'
        });
        const service = new AppClientInboxService({
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database,
            clientStateService: {
                ...clientStateService,
                read: async (command) => {
                    const read = await clientStateService.read(command);
                    if (!('sessionId' in command) || command.sessionId !== 'alice-second') {
                        return read;
                    }
                    if (!read.snapshot || !read.principal) {
                        throw new Error('Expected the seeded principal and snapshot');
                    }
                    return field === 'snapshot'
                        ? { ...read, snapshot: { ...read.snapshot, activeSessionCount: -1 } }
                        : { ...read, principal: { ...read.principal, value: { ...read.principal.value, applicationId: 'wrong-app' } } };
                }
            }
        }, { serviceId: 'server-12345678' });

        const entry = await service.enqueueExpiredSessions(expiresAtEpochMs + 1);
        await dequeueClientInbox(reader);

        expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.FAILED);
        const result = await results.findByKey(entry.key);
        if (!result) {
            throw new Error('Expected the persisted client expiry rejection');
        }
        const failure = decodePersistedAppInboxFailure(result.resource);
        expect(failure).toMatchObject({ code: 'client-mutation-rejected', status: 400 });
        expect(failure.message).toContain(
            field === 'snapshot' ? 'ClientSnapshot.activeSessionCount' : 'Client principal read is wrongly scoped'
        );
        expect((await clientStateService.readSnapshot(toClientPrincipalRef('alice')))?.stateRevision).toBe(2);
        expect(await clientStateService.listEvents(toClientPrincipalRef('alice'))).toEqual([]);
        expect(await clientStateService.listExpiredSessionCandidates(expiresAtEpochMs + 1)).toHaveLength(2);
        expect(database.outboxEntries.size).toBe(0);
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
        createAppInboxTestResilience()
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

async function seedClientExpiryBatch(
    runtimeRepository: FakeRuntimeStateRepository,
    expiresAtEpochMs: number
): Promise<void> {
    const seed = createClientStatePhaseTestDriver(runtimeRepository, () => expiresAtEpochMs - 1_000);
    for (const sessionId of ['alice-first', 'alice-second']) {
        await seed.connectSession(SCOPE, 'alice', `${sessionId}-browser`, sessionId, {
            generationId: `generation-${sessionId}`,
            presenceState: 'online',
            actorPrincipalId: 'alice',
            actorSessionId: sessionId,
            connectedAtEpochMs: expiresAtEpochMs - 2_000,
            lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
            expiresAtEpochMs,
            requestId: `seed-${sessionId}`
        });
    }
}

function toClientPrincipalRef(principalId: string): ClientPrincipalRef {
    return { ...SCOPE, principalId };
}
