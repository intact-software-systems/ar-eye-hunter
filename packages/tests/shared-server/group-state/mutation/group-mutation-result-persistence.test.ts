import { describe, expect, it } from 'vitest';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { SCOPE, groupRef } from './group-mutation-test-runtime.ts';
import {
  createService,
  requireSnapshot,
  seedOpenGroup,
} from '../presence/group-presence-test-runtime.ts';

describe('convergent group and presence state', () => {
  it('does not make a stale no-op receipt durable', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'ephemeral-no-op-room');
    const service = createService(runtime, 2_000);
    await service.updateGroup(SCOPE, 'ephemeral-no-op-room', {
      displayName: 'ephemeral-no-op-room',
      actorPrincipalId: 'alice',
      requestId: 'retry-after-no-op',
    });
    await service.updateGroup(SCOPE, 'ephemeral-no-op-room', {
      displayName: 'Changed',
      actorPrincipalId: 'alice',
      requestId: 'change-between-retries',
    });
    await service.updateGroup(SCOPE, 'ephemeral-no-op-room', {
      displayName: 'ephemeral-no-op-room',
      actorPrincipalId: 'alice',
      requestId: 'retry-after-no-op',
    });

    expect((await requireSnapshot(runtime, 'ephemeral-no-op-room')).group.displayName).toBe(
      'ephemeral-no-op-room',
    );
    expect(
      await new GroupStateRepository(runtime).findIdempotentGroupMutationReceipt(
        groupRef('ephemeral-no-op-room'),
        'retry-after-no-op',
      ),
    ).toMatchObject({ receipt: { outcome: 'applied' } });
  });
});
