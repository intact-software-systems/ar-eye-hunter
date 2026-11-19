import { computeTopologyChurnReshapeGaps } from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-reshape-gaps.ts';
import { describe, expect, it } from 'vitest';

import { createTopologyChurnPlan, createTopologyChurnRemoval } from './topology-churn-plan-fixtures.ts';

describe('computeTopologyChurnReshapeGaps', () => {
    it('gives the gaps between consecutive reshapes in planned order, skipping the attaches between them', () => {
        const gaps = computeTopologyChurnReshapeGaps([
            // Listed out of planned order: the route answers in storage-key order.
            createTopologyChurnPlan({ version: 5, plannedAtEpochMs: 47_000, change: { kind: 'reshape', reason: 'kind-change' } }),
            createTopologyChurnPlan({ version: 1, plannedAtEpochMs: 1_000, change: { kind: 'reshape', reason: 'kind-change' } }),
            createTopologyChurnPlan({ version: 2, plannedAtEpochMs: 8_000 }),
            createTopologyChurnPlan({ version: 3, plannedAtEpochMs: 16_500, change: { kind: 'reshape', reason: 'leader-rooting' } }),
            createTopologyChurnPlan({ version: 4, plannedAtEpochMs: 30_000 })
        ]);

        expect(gaps).toEqual([15_500, 30_500]);
    });

    it('has no gap without a reshape', () => {
        expect(computeTopologyChurnReshapeGaps([
            createTopologyChurnPlan({ version: 1, plannedAtEpochMs: 1_000 }),
            createTopologyChurnPlan({ version: 2, plannedAtEpochMs: 2_000, change: { kind: 'repair' } })
        ])).toEqual([]);
    });

    it('has no gap for a single reshape, and a removal is no reshape', () => {
        expect(computeTopologyChurnReshapeGaps([
            createTopologyChurnPlan({ version: 1, plannedAtEpochMs: 1_000, change: { kind: 'reshape', reason: 'refinement' } }),
            createTopologyChurnRemoval(2, 2_000)
        ])).toEqual([]);
    });
});
