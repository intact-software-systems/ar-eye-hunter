import { describe, expect, it } from 'vitest';

import {
    computeGroupActivationCondition,
    GROUP_ACTIVATION_HYSTERESIS_WIDTH,
    type GroupActivationCondition,
    type GroupCoverageObservation
} from '@shared/api/group-lifecycle/compute-group-activation-condition.ts';
import { resolveGroupActivationCoverageWithHysteresis } from '@shared/api/group-lifecycle/group-activation-coverage-hysteresis.ts';

const SUCCESS_RATE = 0.9;
const MINIMUM_VIABLE_RATE = 0.5;

describe('resolveGroupActivationCoverageWithHysteresis', () => {
    it('judges a group with no previous condition by the entry thresholds', () => {
        // 0.87 is inside the width but there is no band to hold.
        expect(bandFor(0.87, undefined)).toBe('degraded');
    });

    it('holds `active` while coverage stays within a width of the entry', () => {
        expect(bandFor(0.87, 'active')).toBe('active');
    });

    it('drops `active` once coverage falls a full width below the entry', () => {
        expect(bandFor(0.84, 'active')).toBe('degraded');
    });

    it('holds `degraded` while coverage stays within a width of the floor', () => {
        // Below the floor by 0.03: `failed` on entry thresholds, held at
        // `degraded` because the group is already in that band.
        expect(bandFor(0.47, 'degraded')).toBe('degraded');
    });

    it('drops `degraded` once coverage falls a full width below the floor', () => {
        expect(bandFor(0.44, 'degraded')).toBe('failed');
    });

    it('relaxes only the band the group holds', () => {
        // Previously `active`, now below the floor: the floor is NOT relaxed
        // on the way past, so this is `failed` rather than `degraded`.
        expect(bandFor(0.47, 'active')).toBe('failed');
    });

    it('follows the entry thresholds immediately on the way up', () => {
        expect(bandFor(0.92, 'degraded')).toBe('active');
        expect(bandFor(0.5, 'failed')).toBe('degraded');
    });

    // A width is not an absolute rate: a per-group policy patch that sets one
    // wider than the gap between the bands must not let a below-floor group
    // read `active`.
    it('never relaxes the success threshold below the floor', () => {
        const resolved = resolveGroupActivationCoverageWithHysteresis({
            coverage: coverage(0.55),
            previousCondition: 'active',
            hysteresisWidth: 0.8
        });

        expect(resolved.successRate).toBe(MINIMUM_VIABLE_RATE);
        expect(bandFor(0.45, 'active', 0.8)).toBe('failed');
    });

    it('never relaxes the floor below zero', () => {
        const resolved = resolveGroupActivationCoverageWithHysteresis({
            coverage: { ...coverage(0), minimumViableRate: 0.03 },
            previousCondition: 'degraded',
            hysteresisWidth: GROUP_ACTIVATION_HYSTERESIS_WIDTH
        });

        expect(resolved.minimumViableRate).toBe(0);
    });

    it('leaves the observation untouched for a band with no coverage meaning', () => {
        const observed = coverage(0.87);

        expect(
            resolveGroupActivationCoverageWithHysteresis({
                coverage: observed,
                previousCondition: 'inactive',
                hysteresisWidth: GROUP_ACTIVATION_HYSTERESIS_WIDTH
            })
        ).toEqual(observed);
    });
});

function coverage(coverageRate: number): GroupCoverageObservation {
    return {
        coverageRate,
        successRate: SUCCESS_RATE,
        minimumViableRate: MINIMUM_VIABLE_RATE,
        // The dwell-held bands are the ones hysteresis exists to steady, so
        // every case here is measured with the dwell already satisfied.
        dwellSatisfied: true
    };
}

function bandFor(
    coverageRate: number,
    previousCondition: GroupActivationCondition | undefined,
    hysteresisWidth: number = GROUP_ACTIVATION_HYSTERESIS_WIDTH
): GroupActivationCondition {
    return computeGroupActivationCondition({
        business: 'active',
        lifecycleState: 'active',
        attemptBudgetExhausted: false,
        coverage: resolveGroupActivationCoverageWithHysteresis({
            coverage: coverage(coverageRate),
            previousCondition,
            hysteresisWidth
        })
    });
}
