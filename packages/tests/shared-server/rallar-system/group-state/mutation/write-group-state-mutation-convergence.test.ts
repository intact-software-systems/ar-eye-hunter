import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { groupStatePresenceAdmissionStorageKey } from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;
const BASE_EPOCH_MS = 1_900_000_000_000;

describe('GroupStateService guarded batch convergence', () => {
    it('converges independent group services after a concurrent batch re-read', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        runtime.serializeTransactions = true;
        const eventStore = new OrderedGroupEventStore(runtime);
        const seed = createService({
            runtime,
            eventStore,
            nowEpochMs: BASE_EPOCH_MS,
            attemptCount: 1,
            instanceId: 'seed'
        });
        const groupId = 'independent-group-convergence';
        await seed.createGroup(SCOPE, {
            groupId,
            displayName: 'Independent group convergence',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'independent-group-seed'
        });
        runtime.resetObservations();
        const attempts = [
            (attemptCount: number) =>
                createService({
                    runtime,
                    eventStore,
                    nowEpochMs: BASE_EPOCH_MS + 1_000,
                    attemptCount,
                    instanceId: 'first'
                }).updateGroup(SCOPE, groupId, {
                    displayName: 'Independent first',
                    actorPrincipalId: 'alice',
                    requestId: 'independent-group-first'
                }),
            (attemptCount: number) =>
                createService({
                    runtime,
                    eventStore,
                    nowEpochMs: BASE_EPOCH_MS + 1_001,
                    attemptCount,
                    instanceId: 'second'
                }).updateGroup(SCOPE, groupId, {
                    description: 'Independent second',
                    actorPrincipalId: 'alice',
                    requestId: 'independent-group-second'
                })
        ] as const;
        runtime.blockMatchingBatchReads(
            'group-state:groups',
            groupStateGroupStorageKey({ ...SCOPE, groupId }),
            2
        );

        const firstAttempts = await Promise.allSettled(attempts.map((attempt) => attempt(1)));
        const conflictIndex = firstAttempts.findIndex((result) => result.status === 'rejected');
        expect(firstAttempts[conflictIndex]).toMatchObject({
            status: 'rejected',
            reason: expect.any(RuntimeStateWriteConflictError)
        });
        const retried = await attempts[conflictIndex]!(2);
        const results = [
            ...firstAttempts.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []),
            retried
        ];

        const repository = createTestGroupStateRepository(runtime, eventStore);
        const snapshot = await repository.readSnapshot({ ...SCOPE, groupId });
        const receipts = await Promise.all([
            repository.findIdempotentGroupMutationReceipt(
                { ...SCOPE, groupId },
                'independent-group-first'
            ),
            repository.findIdempotentGroupMutationReceipt(
                { ...SCOPE, groupId },
                'independent-group-second'
            )
        ]);
        expect(results.every(({ status }) => status === 'ok')).toBe(true);
        expect(receipts.map((stored) => stored?.receipt.attemptCount).sort()).toEqual([1, 2]);
        expect(snapshot?.group.snapshotVersion).toBe(3);
        expect(snapshot?.group.displayName).toBe('Independent first');
        expect(snapshot?.group.description).toBe('Independent second');
        expect(eventStore.events).toHaveLength(3);
    });

    it('converges independent presence services on one admission slot', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        runtime.serializeTransactions = true;
        const eventStore = new OrderedGroupEventStore(runtime);
        const groupId = 'independent-presence-convergence';
        const seed = createService({
            runtime,
            eventStore,
            nowEpochMs: BASE_EPOCH_MS,
            attemptCount: 1,
            instanceId: 'seed'
        });
        await seed.createGroup(SCOPE, {
            groupId,
            displayName: 'Independent presence convergence',
            kind: 'room',
            joinMode: 'open',
            maxSessionsPerMember: 1,
            createdByPrincipalId: 'alice',
            requestId: 'independent-presence-seed'
        });
        runtime.resetObservations();
        const ref = { ...SCOPE, groupId };
        runtime.blockMatchingBatchReads(
            'group-state:presence-admissions',
            groupStatePresenceAdmissionStorageKey({
                ...ref,
                principalId: 'alice'
            }),
            2
        );

        const attempts = [
            (attemptCount: number) =>
                createService({
                    runtime,
                    eventStore,
                    nowEpochMs: BASE_EPOCH_MS + 1_000,
                    attemptCount,
                    instanceId: 'first'
                }).connectPresenceSession(SCOPE, groupId, 'session-a', {
                    principalId: 'alice',
                    generationId: 'generation-a',
                    expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                    requestId: 'independent-presence-a'
                }),
            (attemptCount: number) =>
                createService({
                    runtime,
                    eventStore,
                    nowEpochMs: BASE_EPOCH_MS + 1_001,
                    attemptCount,
                    instanceId: 'second'
                }).connectPresenceSession(SCOPE, groupId, 'session-b', {
                    principalId: 'alice',
                    generationId: 'generation-b',
                    expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                    requestId: 'independent-presence-b'
                })
        ] as const;
        const firstAttempts = await Promise.allSettled(attempts.map((attempt) => attempt(1)));
        const conflictIndex = firstAttempts.findIndex((result) => result.status === 'rejected');
        expect(firstAttempts[conflictIndex]).toMatchObject({
            status: 'rejected',
            reason: expect.any(RuntimeStateWriteConflictError)
        });
        const retry = await Promise.allSettled([attempts[conflictIndex]!(2)]);
        const results = [
            ...firstAttempts.filter((result) => result.status === 'fulfilled'),
            ...retry
        ];

        const repository = createTestGroupStateRepository(runtime, eventStore);
        const admission = await repository.findPresenceAdmissionEntry({
            ...ref,
            principalId: 'alice'
        });
        const sessions = await repository.listPresenceSessions(ref);
        const accepted = results.filter(
            (result) => result.status === 'fulfilled' && result.value.status === 'ok'
        );
        expect(accepted).toHaveLength(1);
        expect(runtime.batches).toHaveLength(2);
        expect(admission?.value.admittedSessions).toHaveLength(1);
        expect(sessions).toHaveLength(1);
        expect(eventStore.events).toHaveLength(2);
    });
});

interface ConvergenceServiceInput {
    readonly runtime: ApplyingGuardedBatchRepository;
    readonly eventStore: OrderedGroupEventStore;
    readonly nowEpochMs: number;
    readonly attemptCount: number;
    readonly instanceId: string;
}

function createService({
    runtime,
    eventStore,
    nowEpochMs,
    attemptCount,
    instanceId
}: ConvergenceServiceInput) {
    let generatedId = 0;
    return createTestGroupStateService({
        runtimeRepository: runtime,
        groupStateEventStoreFor: () => eventStore,
        now: () => nowEpochMs,
        randomId: () => `${instanceId}-id-${++generatedId}`,
        attemptCount,
        serviceId: `${instanceId}-group-service`
    });
}
