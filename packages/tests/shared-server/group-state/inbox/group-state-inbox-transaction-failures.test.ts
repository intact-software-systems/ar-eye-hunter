import { describe, expect, it } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
  createGroupStateTransactionBoundaryHarness,
  type GroupTransactionFailurePhase,
} from './group-state-transaction-boundary-fixture.ts';

const FAILURE_PHASES = [
  'domain-write',
  'resource-result-replace',
  'reservation-finish',
  'transaction-commit-return',
] as const satisfies readonly GroupTransactionFailurePhase[];

describe('group-state AppInbox transaction failure boundaries', () => {
  it.each(FAILURE_PHASES)(
    'rolls back and exposes no private result, observation, or wake at %s',
    async (failurePhase) => {
      const harness = await createGroupStateTransactionBoundaryHarness(failurePhase);

      await expect(harness.handler.processMutation(harness.context)).rejects.toThrow(
        `controlled ${failurePhase} failure`,
      );

      expect(harness.reachedStages).toContain(failurePhase);
      expect(await harness.repository.readSnapshot(harness.groupRef)).toBeUndefined();
      expect(await harness.repository.listEvents(harness.groupRef)).toEqual([]);
      expect(await harness.results.findByKey(harness.context.entry.key)).toBeUndefined();
      expect(await harness.queue.getItem(harness.context.entry.key)).toMatchObject({
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1 },
      });
      expect(harness.outboxEntries.size).toBe(0);
      expect(harness.observedSnapshots).toEqual([]);
      expect(harness.readWakeCount()).toBe(0);
    },
  );
});
