import { computeGroupAdmissionDecision, type ComputeGroupAdmissionDecisionInput } from '@shared/api/group-lifecycle/compute-group-admission-decision.ts';
import { GROUP_LIFECYCLE_STATES, type GroupAdmissionPolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { describe, expect, it } from 'vitest';

const NOW = 1_700_000_000_000;
const STATES = GROUP_LIFECYCLE_STATES;
const EVERY_STATE_EXCEPT_FORMING = GROUP_LIFECYCLE_STATES.filter(
    (lifecycleState) => lifecycleState !== 'forming'
);

function decision(
    admission: Partial<GroupAdmissionPolicy>,
    overrides: Partial<Omit<ComputeGroupAdmissionDecisionInput, 'admission'>> = {}
) {
    return computeGroupAdmissionDecision({
        admission: { mode: 'open', untilEpochMs: null, untilMemberCount: null, ...admission },
        lifecycleState: 'forming',
        activeMemberCount: 2,
        invited: false,
        nowEpochMs: NOW,
        ...overrides
    });
}

function deniedCode(result: ReturnType<typeof computeGroupAdmissionDecision>): string | null {
    return result.kind === 'deny' ? result.denial.code : null;
}

describe('group admission decision', () => {
    it('admits open mode in every lifecycle state', () => {
        for (const lifecycleState of STATES) {
            expect(decision({ mode: 'open' }, { lifecycleState })).toEqual({ kind: 'admit' });
        }
    });

    // Plan decision 5.2: closed binds outside FORMING — the roster freezes
    // when establishment begins, and a below-floor return to FORMING
    // re-opens the lobby. Product decision 38 extends the same posture to
    // every new stage, dormant included: failure is not consent to admit.
    it('closed admits only while forming', () => {
        expect(decision({ mode: 'closed' }, { lifecycleState: 'forming' }))
            .toEqual({ kind: 'admit' });
        for (const lifecycleState of EVERY_STATE_EXCEPT_FORMING) {
            expect(deniedCode(decision({ mode: 'closed' }, { lifecycleState })))
                .toBe('group-admission-closed');
        }
    });

    // An invite is the group's consent, so it bypasses the consent mode —
    // but closed and the windows are timing/capacity facts, not consent.
    it('an invite bypasses manager-approval parking and nothing else', () => {
        expect(decision({ mode: 'manager-approval' }, { invited: true }))
            .toEqual({ kind: 'admit' });
        expect(deniedCode(decision({ mode: 'closed' }, {
            lifecycleState: 'active',
            invited: true
        }))).toBe('group-admission-closed');
        expect(deniedCode(decision({ mode: 'manager-approval', untilMemberCount: 2 }, {
            invited: true
        }))).toBe('group-admission-capacity-reached');
    });

    it('manager-approval parks an uninvited join in every lifecycle state', () => {
        for (const lifecycleState of STATES) {
            expect(decision({ mode: 'manager-approval' }, { lifecycleState }))
                .toEqual({ kind: 'park' });
        }
    });

    // Correction 5's own motivating case: the window binds without the group
    // ever activating.
    it('the member-count window closes admission regardless of lifecycle state', () => {
        for (const lifecycleState of STATES) {
            expect(deniedCode(decision({ untilMemberCount: 2 }, { lifecycleState })))
                .toBe('group-admission-capacity-reached');
        }
        expect(decision({ untilMemberCount: 3 })).toEqual({ kind: 'admit' });
    });

    it('the deadline window closes admission once now reaches it', () => {
        expect(deniedCode(decision({ untilEpochMs: NOW })))
            .toBe('group-admission-deadline-passed');
        expect(deniedCode(decision({ untilEpochMs: NOW - 1 })))
            .toBe('group-admission-deadline-passed');
        expect(decision({ untilEpochMs: NOW + 1 })).toEqual({ kind: 'admit' });
    });

    it('a passed window denies rather than parks under manager-approval', () => {
        expect(deniedCode(decision({ mode: 'manager-approval', untilEpochMs: NOW })))
            .toBe('group-admission-deadline-passed');
        expect(deniedCode(decision({ mode: 'manager-approval', untilMemberCount: 1 })))
            .toBe('group-admission-capacity-reached');
    });
});
