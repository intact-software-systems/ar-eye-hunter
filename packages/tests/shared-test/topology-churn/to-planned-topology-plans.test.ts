import { toPlannedTopologyPlans } from '@shared-test/black-box-runner/topology-churn/to-planned-topology-plans.ts';
import { describe, expect, it } from 'vitest';

import { createTopologyChurnPlan, createTopologyChurnRemoval } from './topology-churn-plan-fixtures.ts';

describe('toPlannedTopologyPlans', () => {
    it('keeps the plans with a record, in planned order rather than the route\'s storage order', () => {
        const removal = createTopologyChurnRemoval(9, 500);
        const planned = toPlannedTopologyPlans([
            createTopologyChurnPlan({ version: 3, plannedAtEpochMs: 3_000 }),
            removal,
            createTopologyChurnPlan({ version: 1, plannedAtEpochMs: 1_000 }),
            createTopologyChurnPlan({ version: 2, plannedAtEpochMs: 2_000 })
        ]);

        expect(planned.map((entry) => entry.publicationId)).toEqual(['publication-1', 'publication-2', 'publication-3']);
        expect(planned.map((entry) => entry.plan.plannedAtEpochMs)).toEqual([1_000, 2_000, 3_000]);
    });

    it('answers no plans for a room with only removals', () => {
        expect(toPlannedTopologyPlans([createTopologyChurnRemoval(1, 1_000)])).toEqual([]);
    });
});
