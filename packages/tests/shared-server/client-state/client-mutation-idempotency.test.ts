import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';

import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { ClientPrincipalUpsertAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';

import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';

import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';

import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';

import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
    CLIENT_STATE_TEST_SCOPE as APP_SCOPE,
    createAutoAuthorizingClientStateService,
    processAppInbox,
    requireRightSnapshot,
    requireRightWritten
} from './app-client-inbox-mutation-test-harness.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';

import { emptyRead, entryValue, principalCommand, readAfterWrite, requireWrite } from './client-mutation-compute-test-fixtures.ts';
import { AggregateBarrierRepository, createService, outboxFor } from './client-mutation-concurrency-test-runtime.ts';
import { CLIENT_MUTATION_TEST_SCOPE as SCOPE, clientMutationPrincipalRef as principalRef } from './client-mutation-validation-test-fixtures.ts';
import { CLIENT_MUTATION_SERVICE_SCOPE, toClientPrincipalRef } from './client-state-service-test-fixtures.ts';
import { createClientStateTestDriver } from './client-state-test-runtime.ts';

describe('client mutation idempotency compute', () => {
    it('replays the exact stored receipt, snapshot, and event', async () => {
        const command = await principalCommand();
        const applied = requireWrite(computeClientMutation({ command, read: emptyRead(command) }));
        if (!applied.idempotency) {
            throw new Error('Expected idempotency record');
        }
        const replayRead = {
            ...readAfterWrite(command, applied),
            idempotency: entryValue(applied.idempotency, 1)
        };

        expect(computeClientMutation({ command, read: replayRead })).toEqual({
            outcome: 'replay',
            receipt: applied.receipt,
            snapshot: applied.snapshot,
            event: applied.event
        });
    });

    it('returns exact command hashes for conflicting idempotency content', async () => {
        const command = await principalCommand();
        const applied = requireWrite(computeClientMutation({ command, read: emptyRead(command) }));
        if (!applied.idempotency) {
            throw new Error('Expected idempotency record');
        }
        const conflicting = {
            ...command,
            facts: { ...command.facts, commandHash: `sha256:${'f'.repeat(64)}` }
        };
        const read = {
            ...readAfterWrite(conflicting, applied),
            idempotency: entryValue(applied.idempotency, 1)
        };

        expect(computeClientMutation({ command: conflicting, read })).toEqual({
            outcome: 'idempotency-conflict',
            existingCommandHash: command.facts.commandHash,
            receivedCommandHash: conflicting.facts.commandHash
        });
    });
});

describe('client mutation AppInbox idempotency', () => {
    it('replays stored idempotent mutation results without direct publication', async () => {
        const { reader, service } = createAppInboxIdempotencyHarness();

        const first = await processAppInbox<ClientPrincipalUpsertAppInboxPayload>(service, reader, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'upsert-client-alice-first',
            contextId: `${APP_SCOPE.applicationId}:${APP_SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: APP_SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'Alice',
                    actorPrincipalId: 'alice',
                    requestId: 'upsert-client-alice'
                }
            }
        });

        const replay = await processAppInbox<ClientPrincipalUpsertAppInboxPayload>(service, reader, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'upsert-client-alice-replay',
            contextId: `${APP_SCOPE.applicationId}:${APP_SCOPE.workspaceId}:alice`,
            senderId: 'alice',
            data: {
                scope: APP_SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    displayName: 'Alice',
                    actorPrincipalId: 'alice',
                    requestId: 'upsert-client-alice'
                }
            }
        });

        expect(requireRightSnapshot(replay).principal.displayName).toBe('Alice');
        expect(requireRightWritten(replay).event).toEqual(requireRightWritten(first).event);
    });
});

function createAppInboxIdempotencyHarness() {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    return {
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

describe('client mutation service idempotency', () => {
    it('makes a semantic no-op receipt first-writer-wins', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateTestDriver({
            runtimeRepository,
            now: () => 1_000,
            serviceId: 'client-service'
        });
        await service.upsertPrincipal(CLIENT_MUTATION_SERVICE_SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'seed-alice-no-op'
        });
        await service.upsertPrincipal(CLIENT_MUTATION_SERVICE_SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'alice-no-op'
        });

        const stored = await createTestClientStateRepository(
            runtimeRepository
        ).findIdempotentClientMutationReceipt(toClientPrincipalRef('alice'), 'alice-no-op');
        expect(stored?.receipt.outcome).toBe('no-op');
        await expect(
            service.upsertPrincipal(CLIENT_MUTATION_SERVICE_SCOPE, 'alice', {
                username: 'alice',
                displayName: 'Changed',
                requestId: 'alice-no-op'
            })
        ).rejects.toBeInstanceOf(ClientMutationIdempotencyConflictError);
    });

    it('rejects the same requestId with different semantic content', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateTestDriver({
            runtimeRepository,
            now: () => 1_000,
            serviceId: 'client-service'
        });
        const principalRef = toClientPrincipalRef('alice');

        const first = await service.upsertPrincipal(
            CLIENT_MUTATION_SERVICE_SCOPE,
            principalRef.principalId,
            {
                username: 'alice',
                displayName: 'Alice',
                actorPrincipalId: 'alice',
                requestId: 'upsert-alice'
            }
        );
        await expect(
            service.upsertPrincipal(CLIENT_MUTATION_SERVICE_SCOPE, principalRef.principalId, {
                username: 'alice',
                displayName: 'Alice with changed payload',
                actorPrincipalId: 'alice',
                requestId: 'upsert-alice'
            })
        ).rejects.toBeInstanceOf(ClientMutationIdempotencyConflictError);
        expect(first.result?.event?.eventType).toBe('principal-created');

        const repository = createTestClientStateRepository(runtimeRepository);
        expect((await repository.readSnapshot(principalRef))?.principal.displayName).toBe('Alice');
        expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
            'principal-created'
        ]);
    });
});

describe('client mutation idempotency convergence', () => {
    it(
        'makes equal request races first-writer-wins ' + 'and rejects different semantic content',
        async () => {
            const runtime = new AggregateBarrierRepository();
            const request = {
                username: 'alice',
                displayName: 'Alice',
                metadata: { one: 1, two: 2 },
                requestId: 'same-request'
            } as const;
            runtime.armPrincipalReadBarrier(2);
            const [first, second] = await Promise.all([
                createService(runtime, 1_000).upsertPrincipal(SCOPE, 'alice', request),
                createService(runtime, 9_000).upsertPrincipal(SCOPE, 'alice', {
                    requestId: 'same-request',
                    metadata: { two: 2, one: 1 },
                    displayName: 'Alice',
                    username: 'alice'
                })
            ]);

            expect(second.result?.event).toEqual(first.result?.event);
            const idempotent = await createTestClientStateRepository(
                runtime
            ).findIdempotentClientMutationReceipt(principalRef('alice'), 'same-request');
            expect(idempotent?.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/);
            expect(idempotent?.receipt.commandHash).toBe(idempotent?.commandHash);
            const records = await outboxFor(runtime, ['same-request']);
            expect(records).toHaveLength(2);
            expect(idempotent?.receipt.outboxIds).toEqual(records.map((record) => record.key.resourceId));

            const conflictRuntime = new AggregateBarrierRepository();
            conflictRuntime.armPrincipalReadBarrier(2);
            const results = await Promise.allSettled([
                createService(conflictRuntime, 1_000).upsertPrincipal(SCOPE, 'bob', {
                    username: 'bob',
                    displayName: 'First',
                    requestId: 'different-content'
                }),
                createService(conflictRuntime, 1_001).upsertPrincipal(SCOPE, 'bob', {
                    username: 'bob',
                    displayName: 'Second',
                    requestId: 'different-content'
                })
            ]);
            expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
            const rejected = results.find((result) => result.status === 'rejected');
            expect(rejected).toMatchObject({
                reason: expect.any(ClientMutationIdempotencyConflictError)
            });
            expect(await outboxFor(conflictRuntime, ['different-content'])).toHaveLength(2);
        }
    );
});
