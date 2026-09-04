import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { GroupStateEventCollisionError } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { TestGroupStateEventStore } from '@shared-test/shared-server/test-group-state-event-store.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

class CollidingGroupEventStore extends TestGroupStateEventStore {
    private readonly runtime: ApplyingGuardedBatchRepository;

    constructor(runtime: ApplyingGuardedBatchRepository) {
        super();
        this.runtime = runtime;
    }

    override appendGroupEvent(event: GroupEvent): Promise<void> {
        if (this.runtime.activeTransactionDepth !== 1) {
            throw new Error('Group event append must stay inside the transaction');
        }
        this.runtime.transactionOrder.push('event');
        return Promise.reject(new GroupStateEventCollisionError(event));
    }
}

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;

describe('GroupStateService guarded batch atomicity', () => {
    it('surfaces a write conflict after one explicit mutation attempt', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        runtime.forceNextConflict('guard');
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => 1_000,
            randomId: () => 'single-attempt-id',
            serviceId: 'single-attempt-service'
        });

        await expect(createGroup(service, 'single-attempt')).rejects.toBeInstanceOf(
            RuntimeStateWriteConflictError
        );

        expect(runtime.beginCount).toBe(1);
        expect(runtime.batches).toHaveLength(1);
        expect(runtime.transactionOrder).toEqual(['batch']);
        expect(eventStore.events).toEqual([]);
    });

    it.each(['guard', 'initial-presence-summary', 'receipt'] as const)(
        're-enters a forced %s conflict through an explicit fresh outer attempt',
        async (conflictTarget) => {
            const runtime = new ApplyingGuardedBatchRepository();
            const eventStore = new OrderedGroupEventStore(runtime);
            runtime.forceNextConflict(conflictTarget);
            const attemptOne = createTestGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStoreFor: () => eventStore,
                now: () => 1_000,
                randomId: () => `retry-${conflictTarget}-id`,
                attemptCount: 1,
                serviceId: 'group-batch-retry-service'
            });
            const request = {
                groupId: `retry-${conflictTarget}`,
                displayName: `Retry ${conflictTarget}`,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                requestId: `retry-${conflictTarget}-request`
            } as const;

            await expect(attemptOne.createGroup(SCOPE, request)).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            const written = await createTestGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStoreFor: () => eventStore,
                now: () => 1_000,
                randomId: () => `retry-${conflictTarget}-id`,
                attemptCount: 2,
                serviceId: 'group-batch-retry-service'
            }).createGroup(SCOPE, request);

            expect(written.result?.event).not.toBeNull();
            expect(
                (
                    await createTestGroupStateRepository(
                        runtime,
                        eventStore
                    ).findIdempotentGroupMutationReceipt(
                        { ...SCOPE, groupId: request.groupId },
                        request.requestId
                    )
                )?.receipt.attemptCount
            ).toBe(2);
            expect(runtime.beginCount).toBe(2);
            expect(runtime.batches).toHaveLength(2);
            expect(runtime.readCountsBeforeBatch[1]).toBeGreaterThan(
                runtime.readCountsBeforeBatch[0] ?? 0
            );
            expect(runtime.transactionOrder).toEqual(['batch', 'batch', 'event', 'commit']);
            expect([...runtime.data.values()].every(({ revision }) => revision === 0)).toBe(true);
            expect(eventStore.events).toHaveLength(1);
        }
    );

    it('re-enters an admission conflict through an explicit fresh outer attempt', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        const nowEpochMs = 1_900_000_000_000;
        let generatedId = 0;
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => nowEpochMs,
            randomId: () => `admission-retry-id-${++generatedId}`,
            serviceId: 'admission-retry-service'
        });
        const ref = { ...SCOPE, groupId: 'admission-retry' };
        await service.createGroup(SCOPE, {
            groupId: ref.groupId,
            displayName: 'Admission retry',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'admission-retry-seed'
        });
        runtime.resetObservations();
        runtime.forceNextConflict('presence-admission');

        const connect = () =>
            service.connectPresenceSessionReceipt(
                SCOPE,
                ref.groupId,
                'session-admission-retry',
                {
                    principalId: 'alice',
                    generationId: 'generation-admission-retry',
                    expiresAtEpochMs: nowEpochMs + 30_000,
                    requestId: 'admission-retry-request'
                }
            );
        await expect(connect()).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        const receipt = await createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => nowEpochMs,
            randomId: () => `admission-retry-id-${++generatedId}`,
            attemptCount: 2,
            serviceId: 'admission-retry-service'
        }).connectPresenceSessionReceipt(
            SCOPE,
            ref.groupId,
            'session-admission-retry',
            {
                principalId: 'alice',
                generationId: 'generation-admission-retry',
                expiresAtEpochMs: nowEpochMs + 30_000,
                requestId: 'admission-retry-request'
            }
        );

        expect(receipt.attemptCount).toBe(2);
        expect(runtime.beginCount).toBe(2);
        expect(runtime.batches).toHaveLength(2);
        expect(runtime.transactionOrder).toEqual(['batch', 'batch', 'event', 'commit']);
        expect(
            (
                await runtime.findEntry(
                    'group-state:sessions',
                    groupStatePresenceSessionStorageKey({
                        ...ref,
                        sessionId: 'session-admission-retry'
                    })
                )
            )?.revision
        ).toBe(0);
        expect(
            (
                await runtime.findEntry(
                    'group-state:presence-admissions',
                    groupStatePresenceAdmissionStorageKey({
                        ...ref,
                        principalId: 'alice'
                    })
                )
            )?.revision
        ).toBe(0);
        expect(eventStore.events).toHaveLength(2);
    });

    it('surfaces every explicit outer guard conflict without leaking rows or events', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        runtime.forceNextConflict('guard');
        runtime.forceNextConflict('guard');
        runtime.forceNextConflict('guard');
        const before = new Map(runtime.data);

        for (const attemptCount of [1, 2, 3]) {
            const service = createTestGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStoreFor: () => eventStore,
                now: () => 1_000,
                randomId: () => 'guard-exhaustion-id',
                attemptCount,
                serviceId: 'guard-exhaustion-service'
            });
            await expect(createGroup(service, 'guard-exhaustion')).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
        }

        expect(runtime.beginCount).toBe(3);
        expect(runtime.batches).toHaveLength(3);
        expect(runtime.transactionOrder).toEqual(['batch', 'batch', 'batch']);
        expect(runtime.data).toEqual(before);
        expect(eventStore.events).toEqual([]);
    });

    it('keeps an event collision terminal and rolls its batch back', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new CollidingGroupEventStore(runtime);
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => 1_000,
            randomId: () => 'event-conflict-id',
            serviceId: 'event-conflict-service'
        });
        const before = new Map(runtime.data);

        await expect(createGroup(service, 'event-conflict')).rejects.toBeInstanceOf(
            GroupStateEventCollisionError
        );

        expect(runtime.transactionOrder).toEqual(['batch', 'event']);
        expect(runtime.data).toEqual(before);
        expect(eventStore.events).toEqual([]);
    });

    it('treats a missing member-put result as a terminal invariant failure', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        runtime.omitNextEffectResult('member:alice');
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => 1_000,
            randomId: () => 'missing-member-result-id',
            serviceId: 'missing-member-result-service'
        });
        const before = new Map(runtime.data);

        await expect(createGroup(service, 'missing-member-result')).rejects.toThrow(
            'expected 3 effects, received 2'
        );

        expectTerminalRollback(runtime, eventStore.events, before);
    });
});

function createGroup(service: ReturnType<typeof createTestGroupStateService>, groupId: string) {
    return service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `${groupId}-request`
    });
}

function expectTerminalRollback(
    runtime: ApplyingGuardedBatchRepository,
    events: readonly GroupEvent[],
    before: ReadonlyMap<string, RuntimeStateEntry>
): void {
    expect(runtime.beginCount).toBe(1);
    expect(runtime.batches).toHaveLength(1);
    expect(runtime.transactionOrder).toEqual(['batch']);
    expect(runtime.data).toEqual(before);
    expect(events).toEqual([]);
}
