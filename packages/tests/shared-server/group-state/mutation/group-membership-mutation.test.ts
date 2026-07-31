import { describe, expect, it } from 'vitest';

import {
  GroupBarrierRepository,
  SCOPE,
  createService,
  requireSnapshot,
  seedOpenGroup,
} from './group-mutation-test-runtime.ts';

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
