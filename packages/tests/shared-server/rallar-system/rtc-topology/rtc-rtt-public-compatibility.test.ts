import { describe, expect, it } from 'vitest';
import { validateRttMutationFacts } from '@shared-server/mod.ts';

describe('RTC RTT public compatibility', () => {
  it('keeps the legacy mutation-facts validator export', () => {
    expect(() =>
      validateRttMutationFacts({
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        requestedAtEpochMs: 1_000,
        purgeAfterEpochMs: 2_000,
      }),
    ).not.toThrow();
  });
});
