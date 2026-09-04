import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import {
    readAuthenticatedClientMutationIngress,
    toAuthenticatedClientMutationContextId,
    validateIssuedClientMutationIngress
} from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import type { AppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import {
    CLIENT_STATE_TEST_SCOPE as SCOPE,
    createResilience,
    issuedSession,
    processAuthenticatedClientMutation,
    readEntries
} from './app-client-inbox-mutation-test-harness.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';
import { createClientStateServiceFixture } from './create-client-state-service-fixture.ts';

describe('AppClientInbox authentication', () => {
    it('validates issued authority from an explicit observation time without reading the clock', () => {
        const authority = issuedSession('alice', 'alice-session');
        const ingress = readAuthenticatedClientMutationIngress({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'explicit-validation-time',
            contextId: toAuthenticatedClientMutationContextId({
                scope: SCOPE,
                principalId: 'alice',
                callerClientId: authority.clientId,
                callerSessionId: authority.sessionId
            }),
            senderId: authority.clientId,
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    requestId: 'explicit-validation-time',
                    actorPrincipalId: authority.clientId,
                    actorSessionId: authority.sessionId
                }
            }
        });
        const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
            throw new Error('validation read the clock');
        });

        try {
            expect(() =>
                validateIssuedClientMutationIngress(
                    authority,
                    ingress,
                    authority.issuedAtEpochMs + 1
                )
            ).not.toThrow();
        }
        finally {
            dateNow.mockRestore();
        }
    });

    it('returns the exact terminal left for a malformed completed client result', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const database = createAppInboxTestDatabase(queue, results);
        const service = new AppClientInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database,
                clientStateService: createClientStateServiceFixture()
            },
            { serviceId: 'server-12345678' }
        );
        const authority = issuedSession('alice', 'alice-session');
        const pending = service.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId: 'malformed-client-result',
                contextId: toAuthenticatedClientMutationContextId({
                    scope: SCOPE,
                    principalId: 'alice',
                    callerClientId: authority.clientId,
                    callerSessionId: authority.sessionId
                }),
                senderId: authority.clientId,
                data: {
                    scope: SCOPE,
                    principalId: 'alice',
                    request: {
                        username: 'alice',
                        actorPrincipalId: authority.clientId,
                        actorSessionId: authority.sessionId,
                        requestId: 'malformed-client-result'
                    }
                }
            },
            authority
        );

        await vi.waitFor(async () => expect(await readEntries(queue)).toHaveLength(1));
        const [queued] = await readEntries(queue);
        if (queued === undefined) {
            throw new Error('Expected a durable client queue entry');
        }
        const completed = {
            ...queued,
            resource: JSON.stringify({ status: 'ok' }),
            status: EntityStatus.COMPLETED
        };
        await results.replace(completed);
        await queue.enqueue(completed);

        const result = await pending;
        expect(result.right).toBeUndefined();
        expect(result.left).toEqual({
            type: 'app-inbox-failure',
            code: 'app-inbox-result-corrupt',
            status: 500,
            message: 'Persisted AppInbox result is corrupt',
            issues: null,
            denial: null,
            retry: null
        });
    });

    it('rejects forged operation topics and contexts before enqueue', async () => {
        const queue = new TestResourceInbox();
        const authority = issuedSession('alice', 'alice-session');
        const service = new AppClientInboxService(
            {
                inboxQueueReader: new InboxQueueReader(queue),
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: new TestResourceInboxResults(),
                database: createAppInboxTestDatabase(queue, new TestResourceInboxResults()),
                clientStateService: createClientStateServiceFixture()
            },
            { serviceId: 'server-12345678' }
        );
        const enqueue = {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
            resourceId: 'forged-client-context-request',
            contextId: 'application=wrong:workspace=wrong:principal=alice:caller=alice:session=alice-session',
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'forged-client-context-request'
                }
            }
        };

        await expect(service.processAuthenticatedEntryUntilCompletion(enqueue, authority))
            .rejects.toThrow(/operation|context|identity/i);
        expect(await readEntries(queue)).toEqual([]);
    });

    it('does not trust a persisted Mallory actor claim for Alice authority', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const authSessions = new AuthSessionRepository(runtimeRepository);
        const mallory = issuedSession('mallory', 'mallory-session');
        await authSessions.putSession(mallory);
        const service = createClientStateService({
            runtimeRepository,
            clientStateEventStore: new InMemoryClientStateEventStore(),
            serviceId: 'server-12345678'
        });
        const command = await toClientMutationCommand(
            toUpsertClientPrincipalMutationInput({
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'Mallory controlled',
                    actorPrincipalId: 'mallory',
                    actorSessionId: 'mallory-session',
                    requestId: 'direct-mallory-targets-alice'
                },
                defaultCommandId: 'direct-mallory-targets-alice'
            }),
            {
                nowEpochMs: Date.now(),
                serviceId: 'server-12345678',
                eventId: 'direct-mallory-targets-alice-event',
                attemptCount: 1,
                expireAtEpochMs: Date.now() + 60_000
            },
            toClientMutationIssuedSessionAuthority(mallory, SCOPE, 'upsertPrincipal')
        );
        const read = await service.read(command);
        const computed = service.compute(command, read);

        expect(() => service.validate(command, read, computed)).toThrow(
            /authority|authenticated|principal/i
        );
    });

    it('rejects a durable Mallory authority targeting Alice before any domain write', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository
        });
        const authSessions = new AuthSessionRepository(runtimeRepository);
        const mallory = issuedSession('mallory', 'mallory-session');
        await authSessions.putSession(mallory);
        const service = new AppClientInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: database,
                clientStateService: createClientStateService({
                    runtimeRepository,
                    clientStateEventStore: new InMemoryClientStateEventStore(),
                    serviceId: 'server-12345678'
                })
            },
            {
                serviceId: 'server-12345678'
            }
        );

        await expect(
            processAuthenticatedClientMutation(
                service,
                {
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
                            requestId: 'mallory-targets-alice'
                        }
                    }
                },
                mallory
            )
        ).rejects.toThrow(/principal|authority|authenticated/i);

        expect(
            await createTestClientStateRepository(runtimeRepository).readSnapshot({
                ...SCOPE,
                principalId: 'alice'
            })
        ).toBeUndefined();
        expect(database.outboxEntries.size).toBe(0);
    });

    it('rereads revoked durable authority after an outer AppInbox CAS retry', async () => {
        const harness = await createRevokedAuthorityRetryHarness();
        const pending = startRevokedAuthorityMutation(harness);

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await new Promise((resolve) => setTimeout(resolve, 2));
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        const result = await pending;
        expect(result.left?.message).toMatch(/expired|missing|revoked|authority|authenticated/i);
        expect(harness.wasRevoked()).toBe(true);
        expect(
            await createTestClientStateRepository(harness.runtimeRepository).readSnapshot({
                ...SCOPE,
                principalId: 'alice'
            })
        ).toBeUndefined();
        expect(harness.database.outboxEntries.size).toBe(0);
        const [entry] = await readEntries(harness.queue);
        expect(entry.dequeueAudit.attempts).toBe(2);
    });
});

interface RevokedAuthorityRetryHarness {
    readonly alice: IssuedAuthSession;
    readonly database: AppInboxTestDatabase;
    readonly queue: TestResourceInbox;
    readonly reader: InboxQueueReader;
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly service: AppClientInboxService;
    wasRevoked(): boolean;
}

async function createRevokedAuthorityRetryHarness(): Promise<RevokedAuthorityRetryHarness> {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const alice = issuedSession('alice', 'alice-session');
    await authSessions.putSession(alice);
    let injectedConflict = false;
    runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
        if (
            !injectedConflict &&
            operation === 'insertIfAbsent' &&
            namespace === 'client-state:principals'
        ) {
            injectedConflict = true;
            runtimeRepository.data.set(`${namespace}::${key}`, {
                key,
                value: JSON.stringify({ competing: true }),
                expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                updatedTimestamp: new Date().toISOString(),
                revision: 0
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
        }
    });
    const service = new AppClientInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: database,
            clientStateService: createClientStateService({
                runtimeRepository,
                clientStateEventStore: new InMemoryClientStateEventStore(),
                serviceId: 'server-12345678'
            })
        },
        { serviceId: 'server-12345678' }
    );
    return {
        alice,
        database,
        queue,
        reader,
        runtimeRepository,
        service,
        wasRevoked: () => revoked
    };
}

function startRevokedAuthorityMutation(harness: RevokedAuthorityRetryHarness) {
    return processAuthenticatedClientMutation(
        harness.service,
        {
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
                    requestId: 'alice-revoked-after-conflict'
                }
            }
        },
        harness.alice
    );
}
