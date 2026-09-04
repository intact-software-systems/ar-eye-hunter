import { describe, expect, it } from 'vitest';

import {
    computeGroupActivationCondition,
    computeLayoutStale,
    GROUP_ACTIVATION_HYSTERESIS_WIDTH,
    GROUP_ACTIVATION_STATUS_DWELL_MS,
    resolveCoverageBasisLayoutIdentity,
    resolveGroupActivationRemediation,
    resolveGroupBusinessLiveness,
    type ComputeGroupActivationConditionInput,
    type GroupCoverageObservation
} from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

function coverage(overrides: Partial<GroupCoverageObservation> = {}): GroupCoverageObservation {
    return {
        coverageRate: 1,
        successRate: 0.95,
        minimumViableRate: 0.5,
        dwellSatisfied: true,
        ...overrides
    };
}

function condition(
    overrides: Partial<ComputeGroupActivationConditionInput> = {}
): ReturnType<typeof computeGroupActivationCondition> {
    return computeGroupActivationCondition({
        business: 'active',
        lifecycleState: 'active',
        attemptBudgetExhausted: false,
        coverage: coverage(),
        ...overrides
    });
}

const ACCEPTED: GroupLayoutIdentity = {
    groupRevision: 3,
    presenceRevision: 7,
    version: 1,
    state: 'active'
};

const PLANNED: GroupLayoutIdentity = {
    groupRevision: 4,
    presenceRevision: 8,
    version: 2,
    state: 'active'
};

describe('computeGroupActivationCondition', () => {
    // The product's precedence table, one row per order position.
    it('reads failed when the attempt budget is spent', () => {
        expect(condition({ lifecycleState: 'dormant', attemptBudgetExhausted: true, coverage: undefined }))
            .toBe('failed');
    });

    // Exhaustion is a dormant fact (the spent series parked the group there);
    // a group still dialing its final attempt is judged by its coverage.
    it('does not read failed for exhaustion outside dormant', () => {
        expect(condition({
            lifecycleState: 'connecting',
            attemptBudgetExhausted: true,
            coverage: coverage({ coverageRate: 1 })
        })).toBe('active');
        expect(condition({
            lifecycleState: 'connecting',
            attemptBudgetExhausted: true,
            coverage: undefined
        })).toBe('inactive');
    });

    it('reads failed below the floor once the dwell is satisfied', () => {
        expect(condition({ coverage: coverage({ coverageRate: 0.4 }) })).toBe('failed');
    });

    it('reads inactive while no layout is carrying traffic or being dialed', () => {
        expect(condition({ lifecycleState: 'dormant', coverage: undefined })).toBe('inactive');
        expect(condition({ lifecycleState: 'forming', coverage: undefined })).toBe('inactive');
        expect(condition({ lifecycleState: 'planned', coverage: undefined })).toBe('inactive');
    });

    it('reads degraded between the floor and the success rate for the dwell', () => {
        expect(condition({ coverage: coverage({ coverageRate: 0.7 }) })).toBe('degraded');
        expect(condition({ coverage: coverage({ coverageRate: 0.7, dwellSatisfied: false }) }))
            .toBe('initialising');
    });

    it('reads active at or above the success rate', () => {
        expect(condition({ coverage: coverage({ coverageRate: 0.95 }) })).toBe('active');
    });

    it('reads initialising while dialing has begun and no band is held', () => {
        expect(condition({
            lifecycleState: 'connecting',
            coverage: coverage({ coverageRate: 0.1, dwellSatisfied: false })
        })).toBe('initialising');
    });

    // Total over the business plane (product decision 41): a frozen routing
    // plane makes no coverage claim.
    it('reads inactive for every non-live business state in every stage', () => {
        for (const business of ['archived', 'deleted', 'expired'] as const) {
            for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
                expect(condition({ business, lifecycleState, attemptBudgetExhausted: true }))
                    .toBe('inactive');
            }
        }
    });
});

describe('resolveGroupActivationRemediation', () => {
    it('names the two awaiting-application cases and nothing else', () => {
        expect(resolveGroupActivationRemediation({
            business: 'active',
            lifecycleState: 'dormant',
            attemptBudgetExhausted: true,
            replanning: 'auto',
            layoutStale: false,
            replanQueued: false
        })).toBe('awaiting-application');
        expect(resolveGroupActivationRemediation({
            business: 'active',
            lifecycleState: 'active',
            attemptBudgetExhausted: false,
            replanning: 'commanded',
            layoutStale: true,
            replanQueued: false
        })).toBe('awaiting-application');
    });

    it('reads replan-queued while a replan is queued', () => {
        expect(resolveGroupActivationRemediation({
            business: 'active',
            lifecycleState: 'active',
            attemptBudgetExhausted: false,
            replanning: 'debounced',
            layoutStale: true,
            replanQueued: true
        })).toBe('replan-queued');
    });

    it('reads none for a stale layout the replanning policy will fix', () => {
        expect(resolveGroupActivationRemediation({
            business: 'active',
            lifecycleState: 'active',
            attemptBudgetExhausted: false,
            replanning: 'auto',
            layoutStale: true,
            replanQueued: false
        })).toBe('none');
    });

    it('claims nothing for a non-live business state', () => {
        expect(resolveGroupActivationRemediation({
            business: 'archived',
            lifecycleState: 'dormant',
            attemptBudgetExhausted: true,
            replanning: 'commanded',
            layoutStale: true,
            replanQueued: true
        })).toBe('none');
    });
});

describe('resolveCoverageBasisLayoutIdentity', () => {
    it('is the accepted layout whenever one exists', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            expect(resolveCoverageBasisLayoutIdentity({
                lifecycleState,
                accepted: ACCEPTED,
                plannedCandidate: PLANNED
            })).toEqual(ACCEPTED);
        }
    });

    it('is the frozen planned candidate only during initial connecting', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            const basis = resolveCoverageBasisLayoutIdentity({
                lifecycleState,
                accepted: undefined,
                plannedCandidate: PLANNED
            });
            if (lifecycleState === 'connecting') {
                expect(basis).toEqual(PLANNED);
            }
            else {
                expect(basis, lifecycleState).toBeUndefined();
            }
        }
    });
});

describe('computeLayoutStale', () => {
    const accepted: GroupLayoutIdentity = { groupRevision: 3, presenceRevision: 4, version: 1, state: 'active' };

    it('is never stale without an accepted layout', () => {
        expect(computeLayoutStale({
            acceptedIdentity: null,
            plannedIdentity: { ...accepted, version: 2 },
            plannedFingerprint: 'aa',
            planningAuthorityFingerprint: 'bb'
        })).toBe(false);
    });

    it('is stale whenever the group does not run on the planned layout', () => {
        expect(computeLayoutStale({
            acceptedIdentity: accepted,
            plannedIdentity: { ...accepted, version: 2 },
            plannedFingerprint: 'aa',
            planningAuthorityFingerprint: 'aa'
        })).toBe(true);
        expect(computeLayoutStale({
            acceptedIdentity: accepted,
            plannedIdentity: null,
            plannedFingerprint: 'aa',
            planningAuthorityFingerprint: 'aa'
        })).toBe(true);
    });

    it('compares the planned fingerprint with the authority once the identities agree', () => {
        expect(computeLayoutStale({
            acceptedIdentity: accepted,
            plannedIdentity: accepted,
            plannedFingerprint: 'aa',
            planningAuthorityFingerprint: 'bb'
        })).toBe(true);
        expect(computeLayoutStale({
            acceptedIdentity: accepted,
            plannedIdentity: accepted,
            plannedFingerprint: 'aa',
            planningAuthorityFingerprint: 'aa'
        })).toBe(false);
        expect(computeLayoutStale({
            acceptedIdentity: accepted,
            plannedIdentity: accepted,
            plannedFingerprint: null,
            planningAuthorityFingerprint: 'aa'
        })).toBe(true);
    });
});

describe('remediation under an unreadable policy', () => {
    // A policy the server cannot read is also one its automation cannot
    // replan under, so a stale layout is the application's move either way.
    it.each(
        [
            ['commanded', 'awaiting-application'],
            ['corrupt', 'awaiting-application'],
            ['auto', 'none'],
            ['debounced', 'none']
        ] as const
    )('reads a stale layout under %s as %s', (replanning, expected) => {
        expect(resolveGroupActivationRemediation({
            business: 'active',
            lifecycleState: 'active',
            attemptBudgetExhausted: false,
            replanning,
            layoutStale: true,
            replanQueued: false
        })).toBe(expected);
    });
});

describe('resolveGroupBusinessLiveness', () => {
    // The value form of `requireActiveGroup`, so a read surface answers the
    // business plane the same way a policy denial does.
    it.each([
        { label: 'an archived group', status: 'archived' as const, expiresAtEpochMs: null, liveness: 'archived' },
        { label: 'a deleted group', status: 'deleted' as const, expiresAtEpochMs: null, liveness: 'deleted' },
        { label: 'a live group with no expiry', status: 'active' as const, expiresAtEpochMs: null, liveness: 'active' },
        { label: 'a live group before its expiry', status: 'active' as const, expiresAtEpochMs: 2_001, liveness: 'active' },
        { label: 'a group at its expiry instant', status: 'active' as const, expiresAtEpochMs: 2_000, liveness: 'expired' },
        { label: 'a group past its expiry', status: 'active' as const, expiresAtEpochMs: 1_999, liveness: 'expired' }
    ])('reads $label as $liveness', ({ status, expiresAtEpochMs, liveness }) => {
        expect(resolveGroupBusinessLiveness({ status, expiresAtEpochMs }, 2_000)).toBe(liveness);
    });

    // Archival wins over expiry: both freeze the routing plane, and the
    // recorded reason is the one an operator acted on.
    it('reports an archived group as archived even after it expired', () => {
        expect(resolveGroupBusinessLiveness({ status: 'archived', expiresAtEpochMs: 1 }, 2_000)).toBe('archived');
    });
});

describe('activation status constants', () => {
    // Settled once here so no later slice invents values under pressure; the
    // exit band sits a full width below entry so a rate patch cannot invert it.
    it('pins the settled server defaults', () => {
        expect(GROUP_ACTIVATION_STATUS_DWELL_MS).toBe(3_000);
        expect(GROUP_ACTIVATION_HYSTERESIS_WIDTH).toBe(0.05);
    });
});
