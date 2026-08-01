import { describe, expect, it } from 'vitest';
import { createGroupStateService as createDurableGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';

describe('convergent group and presence state', () => {
  it('refuses to construct a user mutation service without an auth repository', () => {
    expect(() =>
      createDurableGroupStateService({
        runtimeRepository: new GroupBarrierRepository(),
        serviceId: 'missing-auth-service',
      } as never),
    ).toThrow(/auth.*required/i);
  });
});
