import { toTopologyChurnPolicy } from '@shared-test/black-box-runner/topology-churn/to-topology-churn-policy.ts';
import { describe, expect, it } from 'vitest';

describe('toTopologyChurnPolicy', () => {
    it('asks only for automatic replanning in an auto room', () => {
        expect(toTopologyChurnPolicy('auto')).toEqual({ replanning: 'auto' });
    });

    it('gives a debounced room the managed preset\'s window, maximum wait and reshape bounds', () => {
        expect(toTopologyChurnPolicy('debounced')).toEqual({
            replanning: 'debounced',
            debounceWindowMs: 500,
            maxReplanWaitMs: 5_000,
            reshapeMinIntervalMs: 15_000,
            reshapeMaxIntervalMs: 60_000
        });
    });
});
