import { describe, expect, it } from 'vitest';

import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';

import { emptyRead, principalCommand } from './client-mutation-compute-test-fixtures.ts';

describe('client mutation pure retry compute', () => {
  it('is deterministic and does not mutate a frozen command or read', async () => {
    const command = deepFreeze(await principalCommand());
    const read = deepFreeze(emptyRead(command));

    const first = computeClientMutation({ command, read });
    const second = computeClientMutation({ command, read });
    validateClientMutation({ command, read, computed: first });
    validateClientMutation({ command, read, computed: second });

    expect(second).toEqual(first);
    expect(command).toEqual(structuredClone(command));
    expect(read).toEqual(structuredClone(read));
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
