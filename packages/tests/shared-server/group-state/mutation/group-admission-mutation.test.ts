import { describe, expect, it } from 'vitest';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';

import { SCOPE, groupRef } from './group-mutation-test-runtime.ts';

function createService(runtime: FakeRuntimeStateRepository, nowEpochMs: number) {
  let id = 0;
  return createTestGroupStateService({
    runtimeRepository: runtime,
    formationDamping: 'damped',
    now: () => nowEpochMs,
    randomId: () => `id-${nowEpochMs}-${++id}`,
    serviceId: 'group-service',
  });
}

// A manager-approval group whose assigned manager is the creator: joins park,
// and only the creator may grant or decline (plan decisions 5.1/5.3).
async function seedManagedGroup(
  runtime: FakeRuntimeStateRepository,
  groupId: string,
  admission: Readonly<Record<string, unknown>> = { mode: 'manager-approval' },
): Promise<void> {
  await createService(runtime, 1_000).createGroup(SCOPE, {
    groupId,
    displayName: groupId,
    kind: 'room',
    joinMode: 'open',
    createdByPrincipalId: 'alice',
    lifecyclePolicy: {
      manager: { selection: 'assigned', assignedPrincipalIds: ['alice'] },
      admission,
    },
    requestId: `seed-${groupId}`,
  });
}

async function memberStatus(
  runtime: FakeRuntimeStateRepository,
  groupId: string,
  principalId: string,
): Promise<string | undefined> {
  const snapshot = await new GroupStateRepository(runtime).readSnapshot(groupRef(groupId));
  return snapshot?.members.find((member) => member.principalId === principalId)?.status;
}

describe('group admission mutation', () => {
  it('parks an uninvited join, declines to left, and grants a re-request to active', async () => {
    const runtime = new FakeRuntimeStateRepository();
    await seedManagedGroup(runtime, 'admission-room');
    const service = createService(runtime, 2_000);

    await service.joinGroup(SCOPE, 'admission-room', {
      actorPrincipalId: 'bob',
      requestId: 'park-bob',
    });
    expect(await memberStatus(runtime, 'admission-room', 'bob')).toBe('pending');

    await service.declineGroupAdmission(SCOPE, 'admission-room', 'bob', {
      actorPrincipalId: 'alice',
      requestId: 'decline-bob',
    });
    expect(await memberStatus(runtime, 'admission-room', 'bob')).toBe('left');

    await service.joinGroup(SCOPE, 'admission-room', {
      actorPrincipalId: 'bob',
      requestId: 'repark-bob',
    });
    expect(await memberStatus(runtime, 'admission-room', 'bob')).toBe('pending');

    await service.grantGroupAdmission(SCOPE, 'admission-room', 'bob', {
      actorPrincipalId: 'alice',
      requestId: 'grant-bob',
    });
    expect(await memberStatus(runtime, 'admission-room', 'bob')).toBe('active');
  });

  it('lets an unexpired invite bypass manager-approval parking', async () => {
    const runtime = new FakeRuntimeStateRepository();
    await seedManagedGroup(runtime, 'invite-bypass-room');
    const service = createService(runtime, 2_000);

    await service.createGroupInvite(SCOPE, 'invite-bypass-room', 'bob', {
      actorPrincipalId: 'alice',
      requestId: 'invite-bob',
    });
    await service.acceptGroupInvite(SCOPE, 'invite-bypass-room', {
      actorPrincipalId: 'bob',
      requestId: 'accept-bob',
    });

    expect(await memberStatus(runtime, 'invite-bypass-room', 'bob')).toBe('active');
  });

  it('denies grant and decline to active non-managers', async () => {
    const runtime = new FakeRuntimeStateRepository();
    await seedManagedGroup(runtime, 'non-manager-room');
    const service = createService(runtime, 2_000);

    await service.createGroupInvite(SCOPE, 'non-manager-room', 'bob', {
      actorPrincipalId: 'alice',
      requestId: 'invite-bob',
    });
    await service.acceptGroupInvite(SCOPE, 'non-manager-room', {
      actorPrincipalId: 'bob',
      requestId: 'accept-bob',
    });
    await service.joinGroup(SCOPE, 'non-manager-room', {
      actorPrincipalId: 'carol',
      requestId: 'park-carol',
    });

    await expect(
      service.grantGroupAdmission(SCOPE, 'non-manager-room', 'carol', {
        actorPrincipalId: 'bob',
        requestId: 'bob-grants-carol',
      }),
    ).rejects.toMatchObject({ denial: { code: 'forbidden-role' } });
    await expect(
      service.declineGroupAdmission(SCOPE, 'non-manager-room', 'carol', {
        actorPrincipalId: 'bob',
        requestId: 'bob-declines-carol',
      }),
    ).rejects.toMatchObject({ denial: { code: 'forbidden-role' } });
    expect(await memberStatus(runtime, 'non-manager-room', 'carol')).toBe('pending');
  });

  it('re-checks the admission window at grant time, not at parking time', async () => {
    const runtime = new FakeRuntimeStateRepository();
    await seedManagedGroup(runtime, 'window-room', {
      mode: 'manager-approval',
      untilMemberCount: 2,
    });
    const service = createService(runtime, 2_000);

    await service.joinGroup(SCOPE, 'window-room', {
      actorPrincipalId: 'carol',
      requestId: 'park-carol',
    });
    // The window closes between the park and the grant: bob's invited join
    // brings the active member count to the limit.
    await service.createGroupInvite(SCOPE, 'window-room', 'bob', {
      actorPrincipalId: 'alice',
      requestId: 'invite-bob',
    });
    await service.acceptGroupInvite(SCOPE, 'window-room', {
      actorPrincipalId: 'bob',
      requestId: 'accept-bob',
    });

    await expect(
      service.grantGroupAdmission(SCOPE, 'window-room', 'carol', {
        actorPrincipalId: 'alice',
        requestId: 'grant-carol',
      }),
    ).rejects.toMatchObject({ denial: { code: 'group-admission-capacity-reached' } });
    expect(await memberStatus(runtime, 'window-room', 'carol')).toBe('pending');
  });

  it('rejects grant without a pending admission and no-ops decline', async () => {
    const runtime = new FakeRuntimeStateRepository();
    await seedManagedGroup(runtime, 'no-pending-room');
    const service = createService(runtime, 2_000);

    await expect(
      service.grantGroupAdmission(SCOPE, 'no-pending-room', 'ghost', {
        actorPrincipalId: 'alice',
        requestId: 'grant-ghost',
      }),
    ).rejects.toThrowError(/No pending admission/);
    await service.declineGroupAdmission(SCOPE, 'no-pending-room', 'ghost', {
      actorPrincipalId: 'alice',
      requestId: 'decline-ghost',
    });
    expect(await memberStatus(runtime, 'no-pending-room', 'ghost')).toBeUndefined();
  });

  it('parks self-upsert activation exactly like the join command', async () => {
    const runtime = new FakeRuntimeStateRepository();
    await seedManagedGroup(runtime, 'upsert-room');
    const service = createService(runtime, 2_000);

    await service.upsertMember(SCOPE, 'upsert-room', 'bob', {
      status: 'active',
      actorPrincipalId: 'bob',
      requestId: 'self-upsert-bob',
    });
    expect(await memberStatus(runtime, 'upsert-room', 'bob')).toBe('pending');
  });

  it('denies joins outside forming under a closed admission mode', async () => {
    const runtime = new FakeRuntimeStateRepository();
    await seedManagedGroup(runtime, 'closed-room', { mode: 'closed' });
    const service = createService(runtime, 2_000);

    await expect(
      service.joinGroup(SCOPE, 'closed-room', {
        actorPrincipalId: 'bob',
        requestId: 'join-closed',
      }),
    ).rejects.toMatchObject({ denial: { code: 'group-admission-closed' } });
  });
});
