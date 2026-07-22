import { describe, expect, it } from 'vitest';

import type { Group, GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
  groupStateGroupStorageKey,
  groupStateIdempotencyStorageKey,
  groupStateMemberStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
  createStateMutationOutboxRecord,
  STATE_MUTATION_OUTBOX_NAMESPACE,
  stateMutationOutboxStorageKey,
} from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { createTestGroupStateService } from './group-state-test-runtime.ts';
import {
  ApplyingGuardedBatchRepository,
  BATCH_SELECTED,
  BeginOnlyGuardedBatchRepository,
  OrderedGroupEventStore,
} from './group-state-guarded-batch-test-runtime.ts';

const SCOPE = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
} as const;

describe('GroupStateService guarded runtime-state batch', () => {
  it('selects the capability exposed only by the transaction repository', async () => {
    const runtime = new BeginOnlyGuardedBatchRepository();
    const service = createTestGroupStateService({
      runtimeRepository: runtime,
      now: () => 1_000,
      randomId: () => 'group-batch-id',
      serviceId: 'group-batch-service',
    });

    await expect(
      service.createGroup(SCOPE, {
        groupId: 'group-1',
        displayName: 'Group 1',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
      }),
    ).rejects.toBe(BATCH_SELECTED);
    expect(runtime.batchCalls).toBe(1);
  });

  it('materializes the exact group-insert bundle before appending its event', async () => {
    const runtime = new ApplyingGuardedBatchRepository();
    const eventStore = new OrderedGroupEventStore(runtime);
    let generatedId = 0;
    const service = createTestGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: () => eventStore,
      now: () => 1_000,
      randomId: () => `group-batch-id-${++generatedId}`,
      serviceId: 'group-batch-service',
    });
    const ref = groupRef('group-insert');

    const written = await service.createGroup(SCOPE, {
      groupId: ref.groupId,
      displayName: 'Group insert',
      kind: 'room',
      joinMode: 'open',
      createdByPrincipalId: 'alice',
      requestId: 'group-insert-request',
    });
    const accepted = written.result.right;
    const event = accepted?.event;
    if (!accepted || !event) {
      throw new Error(written.result.left ?? 'Expected group insert event');
    }
    const repository = new GroupStateRepository(runtime, { events: eventStore });
    const summary = await repository.findPresenceSummaryEntry(ref);
    const idempotency = await repository.findIdempotentGroupMutationReceipt(
      ref,
      'group-insert-request',
    );
    const owner = accepted.snapshot.members.find(({ principalId }) => principalId === 'alice');
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
          expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
        },
        effects: [
          {
            effectId: 'member:alice',
            operation: 'put',
            namespace: 'group-state:members',
            key: groupStateMemberStorageKey(owner),
            value: JSON.stringify(owner),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
          },
          {
            effectId: 'initial-presence-summary',
            operation: 'insert',
            namespace: 'group-state:presence-summaries',
            key: groupStateGroupStorageKey(ref),
            value: JSON.stringify(summary.value),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
          },
          {
            effectId: 'receipt',
            operation: 'insert',
            namespace: 'group-state:idempotent',
            key: groupStateIdempotencyStorageKey(ref, 'group-insert-request'),
            value: JSON.stringify(idempotency),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
          },
        ],
      },
    ]);
    expect(runtime.transactionOrder).toEqual(['batch', 'event', 'commit']);
    expect(eventStore.events).toEqual([event]);
  });
});

export function expectedGroupOutbox(
  group: Group,
  event: GroupEvent,
  receipt: GroupMutationReceipt,
  createdAtEpochMs: number,
) {
  return createStateMutationOutboxRecord({
    kind: 'group',
    aggregateRef: receipt.aggregateRef,
    commandId: receipt.commandId,
    commandHash: receipt.commandHash,
    createdAtEpochMs,
    acceptedCausalRevision: {
      kind: 'group',
      stateRevision: receipt.stateRevision,
      causalRevision: receipt.causalRevision,
      snapshotVersion: group.snapshotVersion,
      metadataVersion: group.metadataVersion,
      rosterVersion: group.rosterVersion,
      presenceVersion: receipt.causalRevision.presenceRevision,
    },
    effects: ['group-state-sync', 'group-presence-summary'],
    event: { kind: 'group', event },
  });
}

export function groupRef(groupId: string): GroupRef {
  return { ...SCOPE, groupId };
}
