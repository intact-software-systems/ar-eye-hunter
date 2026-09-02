import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { GroupStateEventCollisionError, type GroupStateEventWrite } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import { RuntimeStateRetryExhaustedError, RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { TestGroupStateEventStore } from '@shared-test/shared-server/test-group-state-event-store.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

class CollidingGroupEventStore extends TestGroupStateEventStore {
    private readonly runtime: ApplyingGuardedBatchRepository;

    constructor(runtime: ApplyingGuardedBatchRepository) {
        super();
        this.runtime = runtime;
    }

    override appendGroupEvent(computed: GroupStateEventWrite): Promise<void> {
        if (this.runtime.activeTransactionDepth !== 1) {
            throw new Error('Group event append must stay inside the transaction');
        }
        this.runtime.transactionOrder.push('event');
        return Promise.reject(computed.collision);
    }
}

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;

describe('GroupStateService guarded batch atomicity', () => {
    it.each(['guard', 'initial-presence-summary', 'receipt'] as const)(
        'retries a forced %s conflict from a fully fresh read',
        async (conflictTarget) => {
            const runtime = new ApplyingGuardedBatchRepository();
            const eventStore = new OrderedGroupEventStore(runtime);
            const retryDelays: number[] = [];
            const sleep = async (delayMs: number): Promise<void> => {
                expect(runtime.activeTransactionDepth).toBe(0);
                retryDelays.push(delayMs);
            };
            runtime.forceNextConflict(conflictTarget);
            const service = createTestGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStoreFor: () => eventStore,
                now: () => 1_000,
                randomId: () => `retry-${conflictTarget}-id`,
                sleep,
                serviceId: 'group-batch-retry-service'
            });

            const written = await service.createGroup(SCOPE, {
                groupId: `retry-${conflictTarget}`,
                displayName: `Retry ${conflictTarget}`,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                requestId: `retry-${conflictTarget}-request`
            });

            expect(written.result?.event).not.toBeNull();
            expect(runtime.beginCount).toBe(2);
            expect(runtime.batches).toHaveLength(2);
            expect(runtime.readCountsBeforeBatch[1]).toBeGreaterThan(
                runtime.readCountsBeforeBatch[0] ?? 0
            );
            expect(runtime.transactionOrder).toEqual(['batch', 'batch', 'event', 'commit']);
            expect([...runtime.data.values()].every(({ revision }) => revision === 0)).toBe(true);
            expect(eventStore.events).toHaveLength(1);
            expect(retryDelays).toEqual([2]);
        }
    );

    it('retries admission conflict and rolls its session guard back', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        const nowEpochMs = 1_900_000_000_000;
        const retryDelays: number[] = [];
        const sleep = async (delayMs: number): Promise<void> => {
            expect(runtime.activeTransactionDepth).toBe(0);
            retryDelays.push(delayMs);
        };
        let generatedId = 0;
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => nowEpochMs,
            randomId: () => `admission-retry-id-${++generatedId}`,
            sleep,
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

        const receipt = await service.connectPresenceSessionReceipt(
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
        expect(retryDelays).toEqual([2]);
    });

    it('exhausts repeated guard conflicts without leaking rows or events', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        const delays: number[] = [];
        const sleep = async (delayMs: number): Promise<void> => {
            expect(runtime.activeTransactionDepth).toBe(0);
            delays.push(delayMs);
        };
        runtime.forceNextConflict('guard');
        runtime.forceNextConflict('guard');
        runtime.forceNextConflict('guard');
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => 1_000,
            randomId: () => 'guard-exhaustion-id',
            sleep,
            serviceId: 'guard-exhaustion-service'
        });
        const before = new Map(runtime.data);

        let caught: unknown;
        try {
            await createGroup(service, 'guard-exhaustion');
        }
        catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(RuntimeStateRetryExhaustedError);
        if (!(caught instanceof Error)) {
            throw new Error('Expected retry exhaustion to throw an Error');
        }
        expect(caught.cause).toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(runtime.beginCount).toBe(3);
        expect(runtime.batches).toHaveLength(3);
        expect(runtime.transactionOrder).toEqual(['batch', 'batch', 'batch']);
        expect(runtime.data).toEqual(before);
        expect(eventStore.events).toEqual([]);
        expect(delays).toEqual([2, 8]);
    });

    it('keeps an event collision terminal and rolls its batch back', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new CollidingGroupEventStore(runtime);
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => 1_000,
            randomId: () => 'event-conflict-id',
            sleep: rejectUnexpectedRetry,
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
            sleep: rejectUnexpectedRetry,
            serviceId: 'missing-member-result-service'
        });
        const before = new Map(runtime.data);

        await expect(createGroup(service, 'missing-member-result')).rejects.toThrow(
            'expected 3 effects, received 2'
        );

        expectTerminalRollback(runtime, eventStore.events, before);
    });
});

function rejectUnexpectedRetry(): Promise<never> {
    return Promise.reject(new Error('Terminal group mutation failure must not retry'));
}

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
