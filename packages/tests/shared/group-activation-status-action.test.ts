import { describe, expect, it } from 'vitest';

import type { GroupActivationCondition } from '@shared/api/group-lifecycle/compute-group-activation-condition.ts';
import {
    resolveGroupActivationStatusAction,
    type ResolveGroupActivationStatusActionInput
} from '@shared/api/group-lifecycle/resolve-group-activation-status-action.ts';

const NOW = 1_000_000;

describe('resolveGroupActivationStatusAction', () => {
    it('writes a band the evidence alone can confirm', () => {
        expect(actionFor({ coverageRate: 0.95, previousCondition: 'initialising' }))
            .toEqual({ kind: 'write', condition: 'active' });
    });

    // `degraded` is reachable only with the dwell satisfied, so evidence alone
    // may not publish it -- and publishing the undwelt band instead would
    // report the group healthier than its coverage says.
    it('arms the clock for a band only a clock may confirm', () => {
        expect(actionFor({ coverageRate: 0.7, previousCondition: 'active' })).toEqual({
            kind: 'arm-dwell',
            condition: 'degraded',
            dueAtEpochMs: NOW + 3_000
        });
    });

    it('arms the clock for the below-floor band too', () => {
        expect(actionFor({ coverageRate: 0.2, previousCondition: 'active' })).toEqual({
            kind: 'arm-dwell',
            condition: 'failed',
            dueAtEpochMs: NOW + 3_000
        });
    });

    it('does nothing when the band is already on the row', () => {
        expect(actionFor({ coverageRate: 0.95, previousCondition: 'active' }))
            .toEqual({ kind: 'none' });
    });

    // A group already published as degraded must not re-arm its clock on every
    // reading: that is the amplification the dwell exists to prevent.
    it('does nothing when the dwelt band is already on the row', () => {
        expect(actionFor({ coverageRate: 0.7, previousCondition: 'degraded' }))
            .toEqual({ kind: 'none' });
    });

    it('writes immediately on the way back up, with no second dwell', () => {
        expect(actionFor({ coverageRate: 0.95, previousCondition: 'degraded' }))
            .toEqual({ kind: 'write', condition: 'active' });
    });

    it('honours an explicit dwell', () => {
        const action = actionFor({ coverageRate: 0.7, previousCondition: 'active', dwellMs: 500 });

        expect(action).toMatchObject({ kind: 'arm-dwell', dueAtEpochMs: NOW + 500 });
    });
});

function actionFor(
    overrides: Partial<ResolveGroupActivationStatusActionInput> & {
        coverageRate: number;
        previousCondition: GroupActivationCondition | undefined;
    }
) {
    const { coverageRate, ...rest } = overrides;
    return resolveGroupActivationStatusAction({
        business: 'active',
        lifecycleState: 'active',
        attemptBudgetExhausted: false,
        coverage: { coverageRate, successRate: 0.9, minimumViableRate: 0.5 },
        nowEpochMs: NOW,
        ...rest
    });
}
