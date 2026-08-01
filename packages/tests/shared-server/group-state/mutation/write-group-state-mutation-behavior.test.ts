import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { materializeGroupStateGuardedBatch } from '@shared-server/rallar-system/group-state/mutation/write/write-group-state-mutation.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/services/group-state-service.ts';
import { createTestAuthSession, createTestGroupStateRuntime } from '../group-state-test-runtime.ts';
import {
  ApplyingGuardedBatchRepository,
  OrderedGroupEventStore,
} from './group-mutation-test-runtime.ts';

const SCOPE = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
} as const;

describe('GroupStateService guarded batch write boundary', () => {
  it('materializes only authoritative state and receipt while ResourceInbox stays transaction-bound', async () => {
    const runtime = new ApplyingGuardedBatchRepository();
    const eventStore = new OrderedGroupEventStore(runtime);
    const authority = createTestAuthSession('alice');
    const group = createTestGroupStateRuntime({
      runtimeRepository: runtime,
      createGroupStateEventStore: () => eventStore,
      now: () => 1_000,
      serviceId: 'write-boundary-service',
    });
    await group.service.createGroup(SCOPE, {
      groupId: 'write-boundary',
      displayName: 'Write boundary',
      kind: 'room',
      joinMode: 'open',
      createdByPrincipalId: authority.clientId,
      requestId: 'write-boundary-create',
    });

    const prepared = await group.durable.prepareMutation(
      mutationDescriptor('updateGroup', SCOPE, 'write-boundary', {
        displayName: 'Updated through AppInbox',
        actorPrincipalId: authority.clientId,
        requestId: 'write-boundary-update',
      }),
      authority,
    );
    const command = {
      ...prepared,
      facts: { ...prepared.facts, attemptCount: 1 },
    };
    const read = await group.durable.read(command);
    const computed = group.durable.compute(command, read);
    group.durable.validate(command, read, computed);
    expect(computed.outcome).toBe('write');
    if (computed.outcome !== 'write') throw new TypeError('Expected group write');

    const materialized = materializeGroupStateGuardedBatch(computed);
    expect(materialized.batch.guard).toEqual({
      operation: 'update',
      namespace: 'group-state:groups',
      key: groupStateGroupStorageKey(computed.guard.value),
      expectedRevision: 0,
      value: JSON.stringify(computed.guard.value),
      expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
    });
    expect(materialized.batch.effects.map(({ effectId }) => effectId)).toEqual(['receipt']);
    expect(computed.outboxEntries).toHaveLength(1);
    expect(computed.outboxEntries[0]?.typeId).toBe('APP_OUTBOX');
  });
});
