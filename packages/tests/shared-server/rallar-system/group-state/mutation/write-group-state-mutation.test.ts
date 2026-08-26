import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import type { RuntimeStateGuardedBatch } from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

const BATCH_SELECTED = new Error('guarded group batch selected');

class RejectingGuardedBatchRepository extends FakeRuntimeStateRepository {
    batchCalls = 0;

    executeGuardedBatch(_batch: RuntimeStateGuardedBatch): Promise<never> {
        this.batchCalls += 1;
        return Promise.reject(BATCH_SELECTED);
    }
}

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;

describe('GroupStateService guarded runtime-state batch', () => {
    it('executes every group mutation through the required guarded batch operation', async () => {
        const runtime = new RejectingGuardedBatchRepository();
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            now: () => 1_000,
            randomId: () => 'group-batch-id',
            serviceId: 'group-batch-service'
        });

        await expect(
            service.createGroup(SCOPE, {
                groupId: 'group-1',
                displayName: 'Group 1',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice'
            })
        ).rejects.toBe(BATCH_SELECTED);
        expect(runtime.batchCalls).toBe(1);
    });

    it('materializes the exact group-insert bundle before appending its event', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        let generatedId = 0;
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => 1_000,
            randomId: () => `group-batch-id-${++generatedId}`,
            serviceId: 'group-batch-service'
        });
        const ref = groupRef('group-insert');

        const written = await service.createGroup(SCOPE, {
            groupId: ref.groupId,
            displayName: 'Group insert',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'group-insert-request'
        });
        const accepted = written.result;
        const event = accepted.event;
        if (!event) {
            throw new Error('Expected group insert event');
        }
        const repository = createTestGroupStateRepository(runtime, eventStore);
        const summary = await repository.findPresenceSummaryEntry(ref);
        const idempotency = await repository.findIdempotentGroupMutationReceipt(
            ref,
            'group-insert-request'
        );
        const owner = accepted.snapshot.members.find(
            ({ principalId }: GroupMember) => principalId === 'alice'
        );
        if (!summary || !idempotency || !owner) {
            throw new Error('Expected the complete group insert bundle');
        }
        expect(runtime.batches).toEqual([
            {
                guard: {
                    operation: 'insert',
                    namespace: 'group-state:groups',
                    key: groupStateGroupStorageKey(ref),
                    value: JSON.stringify(accepted.snapshot.group),
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                },
                effects: [
                    {
                        effectId: 'member:alice',
                        operation: 'put',
                        namespace: 'group-state:members',
                        key: groupStateMemberStorageKey(owner),
                        value: JSON.stringify(owner),
                        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                    },
                    {
                        effectId: 'initial-presence-summary',
                        operation: 'insert',
                        namespace: 'group-state:presence-summaries',
                        key: groupStateGroupStorageKey(ref),
                        value: JSON.stringify(summary.value),
                        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                    },
                    {
                        effectId: 'receipt',
                        operation: 'insert',
                        namespace: 'group-state:idempotent',
                        key: groupStateIdempotencyStorageKey(ref, 'group-insert-request'),
                        value: JSON.stringify(idempotency),
                        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                    }
                ]
            }
        ]);
        expect(runtime.transactionOrder).toEqual(['batch', 'event', 'commit']);
        expect(eventStore.events).toEqual([event]);
    });

    it('materializes expired group recreation with exact group and summary revisions', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        let generatedId = 0;
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => 1_000,
            randomId: () => `group-recreate-id-${++generatedId}`,
            serviceId: 'group-batch-service'
        });
        const request = {
            groupId: 'group-recreate',
            displayName: 'Old group',
            kind: 'room' as const,
            joinMode: 'open' as const,
            createdByPrincipalId: 'alice',
            requestId: 'group-recreate-old'
        };
        await service.createGroup(SCOPE, request);
        const [groupBefore] = await runtime.findAllEntries('group-state:groups');
        const [summaryBefore] = await runtime.findAllEntries('group-state:presence-summaries');
        if (!groupBefore || !summaryBefore) {
            throw new Error('Expected group predecessors');
        }
        await runtime.upsert('group-state:groups', groupBefore.key, groupBefore.value, 0);
        const expiredGroup = await runtime.findEntry('group-state:groups', groupBefore.key);
        if (!expiredGroup) {
            throw new Error('Expected expired group predecessor');
        }
        runtime.resetObservations();

        await service.createGroup(SCOPE, {
            ...request,
            displayName: 'New group',
            requestId: 'group-recreate-new'
        });

        expect(runtime.batches).toHaveLength(1);
        expect(runtime.batches[0]?.guard).toMatchObject({
            operation: 'update',
            expectedRevision: expiredGroup.revision
        });
        expect(runtime.batches[0]?.effects).toContainEqual(
            expect.objectContaining({
                effectId: 'initial-presence-summary',
                operation: 'update',
                expectedRevision: summaryBefore.revision
            })
        );
        expect((await runtime.findEntry('group-state:groups', groupBefore.key))?.revision).toBe(
            expiredGroup.revision + 1
        );
        expect(
            (await runtime.findEntry('group-state:presence-summaries', summaryBefore.key))?.revision
        ).toBe(summaryBefore.revision + 1);
    });
});

export function groupRef(groupId: string): GroupRef {
    return { ...SCOPE, groupId };
}
