import { describe, expect, it } from 'vitest';
import {
  isValidPersistedResult,
} from '../../../scripts/perf/api-v1-state-write-result-binding.mjs';
import { binding, durableResult } from './state-write-performance-result-fixture.ts';

describe('API-v1 state-write persisted result binding', () => {
  it.each([
    { kind: 'profile-instance', commandType: 'CLIENT_INSTANCE_UPSERT', operationId: 'instance' },
    { kind: 'membership', commandType: 'GROUP_MEMBER_UPSERT', operationId: 'command' },
  ])('rejects a complete $kind result swapped from another command', (shape) => {
    const first = { ...shape, commandId: `first:${shape.kind}` };
    const second = { ...shape, commandId: `second:${shape.kind}` };
    const swappedEntry = {
      commandId: first.commandId,
      commandType: shape.commandType,
      durableResult: durableResult(second, shape.operationId),
    };
    expect(isValidPersistedResult(
      swappedEntry,
      first,
      binding(first, shape.operationId),
    )).toBe(false);
  });
});
