import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requestValidationOwner =
  'packages/shared-server/rallar-system/group-state/mutation/group-mutation-request-validation.ts';

describe('group mutation request validation ownership', () => {
  it('locates request validation at the canonical mutation owner', () => {
    expect(existsSync(requestValidationOwner)).toBe(true);
  });
});
