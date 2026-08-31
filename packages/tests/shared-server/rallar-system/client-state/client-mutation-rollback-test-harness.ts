import { expect } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type { ClientSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { TestClientStateEventStore } from '@shared-test/shared-server/test-client-state-event-store.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import type { AppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { createAutoAuthorizingClientStateService, processAppInbox } from './app-client-inbox-mutation-test-harness.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';

const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

interface RollbackHarness {
    readonly key: Key;
    readonly queue: TestResourceInbox;
    readonly reader: InboxQueueReader;
    readonly results: TestResourceInboxResults;
    readonly service: AppClientInboxService;
    rollbackAssertions(): number;
}
interface RollbackObservation {
    assertions: number;
}
interface RollbackDatabaseInput {
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly eventStore: TestClientStateEventStore;
    readonly repository: ClientStateRepository;
    readonly key: Key;
    readonly observation: RollbackObservation;
}

export async function createRollbackHarness(): Promise<RollbackHarness> {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const eventStore = new TestClientStateEventStore();
    const repository = createTestClientStateRepository(runtimeRepository, eventStore);
    const key = toAppQueueKey({
        topicId: AppInboxType.CLIENT_SESSION_CONNECT,
        resourceId: 'connect-client-rollback',
        contextId: toAuthenticatedClientMutationContextId({
            scope: SCOPE,
            principalId: 'alice',
            callerClientId: 'alice',
            callerSessionId: 'alice-session'
        })
    });
    const observation: RollbackObservation = { assertions: 0 };
    const database = createRollbackDatabase({
        queue,
        results,
        runtimeRepository,
        eventStore,
        repository,
        key,
        observation
    });
    const service = new AppClientInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: database,
            clientStateService: createAutoAuthorizingClientStateService(
                runtimeRepository,
                database,
                eventStore
            )
        },
        {
            serviceId: 'server-12345678'
        }
    );
    return { key, queue, reader, results, service, rollbackAssertions: () => observation.assertions };
}

function createRollbackDatabase(input: RollbackDatabaseInput): AppInboxTestDatabase {
    let failOutbox = true;
    const database = createAppInboxTestDatabase(input.queue, input.results, {
        runtimeRepository: input.runtimeRepository,
        clientEventStore: input.eventStore,
        shouldFailOutboxWrite: () => {
            if (!failOutbox) {
                return false;
            }
            failOutbox = false;
            return true;
        },
        withTransaction: async (write) => restoreEventsAfterFailure(input.eventStore, write)
    });
    const begin = database.begin.bind(database);
    database.begin = async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
        try {
            return await begin(write);
        }
        catch (caught) {
            const error = toError(caught);
            input.observation.assertions += 1;
            await expectRolledBackMutationState({
                database,
                key: input.key,
                queue: input.queue,
                repository: input.repository,
                results: input.results
            });
            throw error;
        }
    };
    return database;
}

export function processRollbackMutation(
    harness: RollbackHarness
): Promise<Either<AppInboxFailure, ClientStateWritten>> {
    const connectedAtEpochMs = Date.now();
    return processAppInbox<ClientSessionConnectAppInboxPayload>(harness.service, harness.reader, {
        type: AppInboxType.CLIENT_SESSION_CONNECT,
        ...harness.key,
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
                requestId: 'connect-client-rollback'
            }
        }
    });
}

async function restoreEventsAfterFailure<T>(
    eventStore: TestClientStateEventStore,
    write: () => Promise<T>
): Promise<T> {
    const before = [...eventStore.events];
    try {
        return await write();
    }
    catch (caught) {
        const error = toError(caught);
        eventStore.events.length = 0;
        eventStore.events.push(...before);
        throw error;
    }
}

interface RolledBackMutationState {
    readonly database: AppInboxTestDatabase;
    readonly key: Key;
    readonly queue: TestResourceInbox;
    readonly repository: ClientStateRepository;
    readonly results: TestResourceInboxResults;
}

async function expectRolledBackMutationState(state: RolledBackMutationState): Promise<void> {
    const principalRef = { ...SCOPE, principalId: 'alice' };
    expect(await state.repository.findPrincipal(principalRef)).toBeUndefined();
    expect(
        await state.repository.findInstance({ ...principalRef, clientInstanceId: 'alice-browser' })
    ).toBeUndefined();
    expect(
        await state.repository.findSession({
            ...principalRef,
            clientInstanceId: 'alice-browser',
            sessionId: 'alice-session'
        })
    ).toBeUndefined();
    expect(
        await state.repository.findIdempotentClientMutationReceipt(
            principalRef,
            'connect-client-rollback'
        )
    ).toBeUndefined();
    expect(await state.repository.listEvents(principalRef)).toEqual([]);
    expect(state.database.outboxEntries.size).toBe(0);
    expect(await state.results.findByKey(state.key)).toBeUndefined();
    expect((await state.queue.getItem(state.key))?.status).toBe(EntityStatus.RESERVED);
}
