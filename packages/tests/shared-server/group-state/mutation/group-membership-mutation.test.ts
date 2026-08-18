import { describe, expect, it } from 'vitest';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';

import { SCOPE, groupRef } from './group-mutation-test-runtime.ts';

class GroupBarrierRepository extends FakeRuntimeStateRepository {}

function createService(runtimeRepository: GroupBarrierRepository, nowEpochMs: number) {
  let id = 0;
  return createTestGroupStateService({
    runtimeRepository,
    formationDamping: 'damped',
    now: () => nowEpochMs,
    randomId: () => `id-${nowEpochMs}-${++id}`,
    serviceId: 'group-service',
  });
}

async function seedOpenGroup(
  runtime: GroupBarrierRepository,
  groupId: string,
  maxMembers = 10,
): Promise<void> {
  await createService(runtime, 1_000).createGroup(SCOPE, {
    groupId,
    displayName: groupId,
    kind: 'room',
    joinMode: 'open',
    maxMembers,
    createdByPrincipalId: 'alice',
    requestId: `seed-${groupId}`,
  });
}

async function requireSnapshot(runtime: GroupBarrierRepository, groupId: string) {
  const snapshot = await new GroupStateRepository(runtime).readSnapshot(groupRef(groupId));
  if (!snapshot) throw new Error(`Missing group snapshot: ${groupId}`);
  return snapshot;
}

describe('group membership mutation computation', () => {
  it('does not fabricate join authority for invites or direct terminal governance', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'nullable-join-room');
    const service = createService(runtime, 2_000);
    await service.upsertMember(SCOPE, 'nullable-join-room', 'bob', {
      status: 'invited',
      actorPrincipalId: 'alice',
      requestId: 'invite-without-join',
    });
    await service.banGroupMember(SCOPE, 'nullable-join-room', 'carol', {
      actorPrincipalId: 'alice',
      requestId: 'direct-ban-without-join',
    });

    const snapshot = await requireSnapshot(runtime, 'nullable-join-room');
    expect(snapshot.members.find((member) => member.principalId === 'bob')).toMatchObject({
      status: 'invited',
      joined: null,
    });
    expect(snapshot.members.find((member) => member.principalId === 'carol')).toMatchObject({
      status: 'banned',
      joined: null,
    });
  });
});
