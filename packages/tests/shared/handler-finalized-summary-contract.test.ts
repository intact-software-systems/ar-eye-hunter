import { describe, expect, it } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { isIdempotentHandlerFinalizedRelease } from '@shared/queuebox/QueueBoxTypes.ts';

import { HANDLER_FINALIZED_SUMMARY_SCENARIOS } from './handler-finalized-summary-test-support.ts';

describe('handler-finalized group presence summary contract', () => {
  it.each(HANDLER_FINALIZED_SUMMARY_SCENARIOS)(
    'accepts only the canonical summary entry: $name',
    ({ accepted, entries }) => {
      const { reserved, current } = entries();

      expect(
        isIdempotentHandlerFinalizedRelease(current, reserved, {
          status: EntityStatus.COMPLETED,
          delayMs: null,
        }),
      ).toBe(accepted);
    },
  );
});
