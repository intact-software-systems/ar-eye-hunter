import { resolveTopologyChurnOutcome } from '@shared-test/black-box-runner/topology-churn/resolve-topology-churn-outcome.ts';
import { describe, expect, it } from 'vitest';

import { createTopologyChurnPlan, createTopologyChurnRemoval, toTopologyChurnLayout } from './topology-churn-plan-fixtures.ts';

// The route answers in storage-key order, so the newest plan is found by its planned instant, not its position.
const PLANS = [
    createTopologyChurnPlan({ version: 3, plannedAtEpochMs: 3_000, topology: 'mesh' }),
    createTopologyChurnPlan({ version: 1, plannedAtEpochMs: 1_000, topology: 'tree' }),
    createTopologyChurnPlan({ version: 2, plannedAtEpochMs: 2_000, topology: 'tree' })
];

describe('resolveTopologyChurnOutcome', () => {
    it('converges when the newest planned record is the accepted layout', () => {
        expect(resolveTopologyChurnOutcome({ plans: PLANS, acceptedLayout: toTopologyChurnLayout(3) }).converged).toBe(true);
    });

    it('has not converged while the accepted layout is an older record or none', () => {
        expect(resolveTopologyChurnOutcome({ plans: PLANS, acceptedLayout: toTopologyChurnLayout(2) }).converged).toBe(false);
        expect(resolveTopologyChurnOutcome({ plans: PLANS, acceptedLayout: null }).converged).toBe(false);
    });

    it('names each kind the plans used once, in planned order', () => {
        expect(resolveTopologyChurnOutcome({ plans: PLANS, acceptedLayout: null }).topology).toEqual(['tree', 'mesh']);
    });

    it('ignores a removal without a record and has not converged on a room with no plan', () => {
        const removal = createTopologyChurnRemoval(4, 4_000, 'star');

        expect(resolveTopologyChurnOutcome({ plans: [...PLANS, removal], acceptedLayout: toTopologyChurnLayout(3) })).toEqual({
            converged: true,
            topology: ['tree', 'mesh']
        });
        expect(resolveTopologyChurnOutcome({ plans: [removal], acceptedLayout: toTopologyChurnLayout(4) })).toEqual({
            converged: false,
            topology: []
        });
    });
});
