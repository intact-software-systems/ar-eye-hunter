import { describe, expect, it } from 'vitest';
import { validateGroupMutationIdempotencyRecord } from '@shared-server/rallar-system/group-state/mutation/group-mutation-result.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';

import {
  GroupBarrierRepository,
  SCOPE,
  createService,
  groupRef as runtimeGroupRef,
  seedOpenGroup,
} from './group-mutation-test-runtime.ts';

const groupRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  groupId: 'group-1',
};

function idempotencyRecord() {
  const commandHash = `sha256:${'a'.repeat(64)}`;
  return {
    aggregateRef: groupRef,
    requestId: 'request-1',
    commandHash,
    receipt: {
      commandId: 'request-1',
      requestId: 'request-1',
      commandHash,
      aggregateRef: groupRef,
      outcome: 'no-op',
      attemptCount: 1,
      acceptedStorageRevision: 0,
      stateRevision: 1,
      snapshotVersion: 1,
      causalRevision: { groupRevision: 1, presenceRevision: 0 },
      eventId: null,
      outboxIds: [],
      joinCode: null,
      joinCodeExpiresAtEpochMs: null,
      rejection: null,
    },
  };
}

describe('group mutation receipt causal invariants', () => {
  it('requires receipt snapshotVersion to equal causal groupRevision', () => {
    const valid = idempotencyRecord();
    expect(() => validateGroupMutationIdempotencyRecord(valid, groupRef)).not.toThrow();

    expect(() =>
      validateGroupMutationIdempotencyRecord(
        {
          ...valid,
          receipt: { ...valid.receipt, snapshotVersion: 2 },
        },
        groupRef,
      ),
    ).toThrow(/snapshotVersion.*causalRevision/u);
  });
});

{
  const groupRef = runtimeGroupRef;

  describe('group mutation rejected-result persistence', () => {
    it('does not persist a rejected receipt, event, or outbox effect', async () => {
      const runtime = new GroupBarrierRepository();
      await seedOpenGroup(runtime, 'ephemeral-rejection-room');
      const result = await createService(runtime, 2_000).createGroup(SCOPE, {
        groupId: 'ephemeral-rejection-room',
        displayName: 'Duplicate',
        kind: 'room',
        createdByPrincipalId: 'alice',
        actorPrincipalId: 'alice',
        requestId: 'rejected-duplicate-create',
      });
      expect(result).toMatchObject({ status: 'error' });
      const repository = new GroupStateRepository(runtime);
      expect(
        await repository.findIdempotentGroupMutationReceipt(
          groupRef('ephemeral-rejection-room'),
          'rejected-duplicate-create',
        ),
      ).toBeUndefined();
      expect(
        (await repository.listEvents(groupRef('ephemeral-rejection-room'))).filter(
          (event) => event.requestId === 'rejected-duplicate-create',
        ),
      ).toEqual([]);
    });
  });
}
