import { describe, expect, it, vi } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import * as clientInboxComputation from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-computation.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import {
    createAutoAuthorizingClientStateService,
    createResilience,
    issuedSession,
    processAuthenticatedClientMutation,
    readEntries
} from './app-client-inbox-mutation-test-harness.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';
import { createRollbackHarness, processRollbackMutation } from './client-mutation-rollback-test-harness.ts';
import { createHandlerHarness } from './client-mutation-transaction-boundary-fixture.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' } as const;

describe('client mutation transaction and outbox', () => {
    it.each(['write', 'envelope'] as const)('rejects deceptive %s projections before transaction entry or candidate reads', async (projection) => {
        const harness = await createHandlerHarness();
        const compute = clientInboxComputation.computeClientStateInboxMutation;
        let candidateReads = 0;
        const computation = vi.spyOn(clientInboxComputation, 'computeClientStateInboxMutation').mockImplementationOnce((read) => {
            const computed = compute(read);
            const write = new Proxy(computed.clientWrites[0], {
                get(target, property, receiver) {
                    candidateReads += 1;
                    return property === 'snapshot'
                        ? { ...target.snapshot, stateRevision: 999 }
                        : Reflect.get(target, property, receiver);
                }
            });
            if (projection === 'write') {
                return { ...computed, clientWrites: [write] };
            }
            return new Proxy(computed, {
                get(target, property, receiver) {
                    candidateReads += 1;
                    return property === 'clientWrites' ? [write] : Reflect.get(target, property, receiver);
                }
            });
        });
        try {
            await expect(harness.handler.processCommand(
                harness.context,
                toUpsertClientPrincipalMutationInput({
                    scope: SCOPE,
                    principalId: 'alice',
                    request: { username: 'alice', actorPrincipalId: 'alice', actorSessionId: 'alice-session' },
                    defaultCommandId: 'client-transaction-result'
                })
            )).rejects.toThrow(TypeError);

            expect(candidateReads).toBe(0);
            expect(harness.actions).toEqual(['read', 'completion-clock', 'mutation.compute', 'mutation.validate']);
            expect(harness.writtenSnapshots).toEqual([]);
            expect(harness.observedSnapshots).toEqual([]);
            expect(await harness.results.findByKey(harness.context.entry.key)).toBeUndefined();
        }
        finally {
            computation.mockRestore();
        }
    });

    it('persists durable JSON bytes before observing the exact committed snapshot', async () => {
        const harness = await createHandlerHarness();

        const result = await harness.handler.processCommand(
            harness.context,
            toUpsertClientPrincipalMutationInput({
                scope: SCOPE,
                principalId: 'alice',
                request: {
                    username: 'alice',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'client-transaction-result'
                },
                defaultCommandId: 'client-transaction-result'
            })
        );

        const persisted = await harness.results.findByKey(harness.context.entry.key);
        expect(persisted?.status).toBe(EntityStatus.COMPLETED);
        expect(persisted?.resource).toBe(JSON.stringify(result));
        expect(result.result.snapshot).toMatchObject({ stateRevision: 1, principal: { username: 'alice' } });
        if (!persisted) {
            throw new Error('Expected the committed AppInbox result');
        }
        const persistedResult = decodeJsonWireValue(JSON.parse(persisted.resource), 'Committed AppInbox result');
        if (persistedResult === null || typeof persistedResult !== 'object' || Array.isArray(persistedResult)) {
            throw new TypeError('Expected committed AppInbox result to be an object');
        }
        expect(Object.keys(persistedResult)).toEqual([
            'status',
            'result'
        ]);
        expect(harness.actions).toEqual([
            'read',
            'completion-clock',
            'mutation.compute',
            'mutation.validate',
            'transaction',
            'write',
            'commit',
            'mutation.write',
            'observe'
        ]);
        expect(harness.observedSnapshots).toHaveLength(1);
        expect(harness.observedSnapshots[0]).toBe(harness.writtenSnapshots[0]);
        expect(result.result?.snapshot).toBe(harness.writtenSnapshots[0]);
    });

    it('does not observe a snapshot when transaction finalization rejects', async () => {
        const harness = await createHandlerHarness({ failTransaction: true });

        await expect(
            harness.handler.processCommand(
                harness.context,
                toUpsertClientPrincipalMutationInput({
                    scope: SCOPE,
                    principalId: 'alice',
                    request: {
                        username: 'alice',
                        actorPrincipalId: 'alice',
                        actorSessionId: 'alice-session',
                        requestId: 'client-transaction-failure'
                    },
                    defaultCommandId: 'client-transaction-failure'
                })
            )
        ).rejects.toThrow('injected transaction failure');

        expect(harness.actions).toEqual([
            'read',
            'completion-clock',
            'mutation.compute',
            'mutation.validate',
            'transaction',
            'mutation.write'
        ]);
        expect(harness.observedSnapshots).toEqual([]);
        expect(await harness.results.findByKey(harness.context.entry.key)).toBeUndefined();
    });
});

describe('client mutation AppInbox retry and rollback', () => {
    it('restarts client phases from read after an AppInbox CAS conflict', async () => {
        const harness = createRetryHarness();

        const resultPromise = processAuthenticatedClientMutation(
            harness.service,
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId: 'retry-client-alice',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
                senderId: 'alice',
                data: {
                    scope: SCOPE,
                    principalId: 'alice',
                    request: {
                        username: 'alice',
                        displayName: 'recomputed-successor',
                        actorPrincipalId: 'alice',
                        requestId: 'retry-client-alice'
                    }
                }
            },
            issuedSession('alice', 'alice-test-session')
        );

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(1_000));
        expect(harness.state.writeAttempt).toBe(1);
        expect((await readEntries(harness.queue))[0].status).toBe(EntityStatus.RETRY);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await resultPromise;

        expect(harness.state.phases).toEqual([
            'read',
            'mutation.compute',
            'mutation.validate',
            'write-conflict',
            'mutation.write',
            'read',
            'mutation.compute',
            'mutation.validate',
            'write-accepted',
            'mutation.write'
        ]);
        const [entry] = await readEntries(harness.queue);
        expect(entry.dequeueAudit.attempts).toBe(2);
    });

    it('rolls back every client mutation surface when final WS outbox insertion fails', async () => {
        const harness = await createRollbackHarness();
        const result = await processRollbackMutation(harness);

        expect(result.left).toMatchObject({
            code: 'resource-inbox-invariant-corruption',
            status: 500
        });
        expect(harness.rollbackAssertions()).toBe(1);
        expect((await harness.queue.getItem(harness.key))?.status).toBe(EntityStatus.FAILED);
        expect(await harness.results.findByKey(harness.key)).toMatchObject({
            status: EntityStatus.FAILED
        });
    });
});

interface RetryHarnessState {
    readonly phases: string[];
    writeAttempt: number;
}

interface RetryHarness {
    readonly queue: TestResourceInbox;
    readonly reader: InboxQueueReader;
    readonly state: RetryHarnessState;
    readonly service: AppClientInboxService;
}

function createRetryHarness(): RetryHarness {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const durable = createAutoAuthorizingClientStateService(runtimeRepository, database);
    const state: RetryHarnessState = { phases: [], writeAttempt: 0 };
    const clientStateService: ClientStateService = {
        ...durable,
        mutationTiming: {
            serviceId: 'server-12345678',
            sink: (event) => {
                state.phases.push(event.operation);
            }
        },
        read: async (command) => {
            state.phases.push('read');
            return await durable.read(command);
        },
        write: async (transaction, computed) => {
            state.writeAttempt += 1;
            if (state.writeAttempt === 1) {
                state.phases.push('write-conflict');
                throw new RuntimeStateWriteConflictError();
            }
            state.phases.push('write-accepted');
            return await durable.write(transaction, computed);
        }
    };
    return {
        queue,
        reader,
        state,
        service: new AppClientInboxService({
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database,
            clientStateService
        }, { serviceId: 'server-12345678' })
    };
}
