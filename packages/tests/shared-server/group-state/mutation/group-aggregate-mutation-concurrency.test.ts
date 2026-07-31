import { describe, expect, it } from 'vitest';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';
import {
  createService,
  requireSnapshot,
  seedOpenGroup,
} from '../presence/group-presence-test-runtime.ts';

describe('convergent group and presence state', () => {
  it('rebases simultaneous create and last-slot joins through the group guard', async () => {
    const runtime = new GroupBarrierRepository();
    const firstCreate = createService(runtime, 1_000).createGroup(SCOPE, {
      groupId: 'capacity-room',
      displayName: 'Capacity Room',
      kind: 'room',
      joinMode: 'open',
      maxMembers: 2,
      createdByPrincipalId: 'alice',
      requestId: 'create-capacity-a',
    });
    const secondCreate = createService(runtime, 1_001).createGroup(SCOPE, {
      groupId: 'capacity-room',
      displayName: 'Capacity Room',
      kind: 'room',
      joinMode: 'open',
      maxMembers: 2,
      createdByPrincipalId: 'alice',
      requestId: 'create-capacity-b',
    });
    const creates = await Promise.allSettled([firstCreate, secondCreate]);
    expect(
      creates.filter(
        (result) => result.status === 'fulfilled' && result.value.status === 'created',
      ),
    ).toHaveLength(1);

    runtime.armGroupReadBarrier(2);
    const joins = await Promise.allSettled([
      createService(runtime, 2_000).joinGroup(SCOPE, 'capacity-room', {
        actorPrincipalId: 'bob',
        requestId: 'join-bob',
      }),
      createService(runtime, 2_001).joinGroup(SCOPE, 'capacity-room', {
        actorPrincipalId: 'carol',
        requestId: 'join-carol',
      }),
    ]);
    expect(joins.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const snapshot = await requireSnapshot(runtime, 'capacity-room');
    expect(snapshot.memberCount).toBe(2);
    expect(snapshot.group.snapshotVersion).toBe(2);
    expect(runtime.locks).toEqual([]);
  });

  it('converges join versus ban under either valid serialization order', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'join-ban-room');
    await createService(runtime, 1_100).upsertMember(SCOPE, 'join-ban-room', 'bob', {
      status: 'invited',
      actorPrincipalId: 'alice',
      requestId: 'invite-bob',
    });
    runtime.armGroupReadBarrier(2);
    const results = await Promise.allSettled([
      createService(runtime, 2_000).joinGroup(SCOPE, 'join-ban-room', {
        actorPrincipalId: 'bob',
        requestId: 'join-bob-race',
      }),
      createService(runtime, 2_001).banGroupMember(SCOPE, 'join-ban-room', 'bob', {
        actorPrincipalId: 'alice',
        requestId: 'ban-bob-race',
      }),
    ]);

    expect(results[1]).toMatchObject({ status: 'fulfilled' });
    const snapshot = await requireSnapshot(runtime, 'join-ban-room');
    expect(snapshot.members.find((member) => member.principalId === 'bob')).toMatchObject({
      status: 'banned',
    });
    expect(snapshot.group.snapshotVersion).toBe(
      2 + results.filter((result) => result.status === 'fulfilled').length,
    );
  });

  it('rebases ownership transfer versus target removal without losing a winner', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'owner-race-room');
    await createService(runtime, 1_100).upsertMember(SCOPE, 'owner-race-room', 'bob', {
      status: 'active',
      actorPrincipalId: 'alice',
      requestId: 'activate-bob',
    });
    runtime.armGroupReadBarrier(2);
    const results = await Promise.allSettled([
      createService(runtime, 2_000).transferGroupOwnership(SCOPE, 'owner-race-room', {
        newOwnerPrincipalId: 'bob',
        actorPrincipalId: 'alice',
        requestId: 'transfer-to-bob',
      }),
      createService(runtime, 2_001).removeGroupMember(SCOPE, 'owner-race-room', 'bob', {
        actorPrincipalId: 'alice',
        requestId: 'remove-bob-race',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const snapshot = await requireSnapshot(runtime, 'owner-race-room');
    const owners = snapshot.members.filter(
      (member) => member.role === 'owner' && member.status === 'active',
    );
    expect(owners).toHaveLength(1);
    const bob = snapshot.members.find((member) => member.principalId === 'bob');
    expect(
      (owners[0]?.principalId === 'bob' && bob?.status === 'active') ||
        (owners[0]?.principalId === 'alice' && bob?.status === 'removed'),
    ).toBe(true);
  });
});
