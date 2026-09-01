import { describe, expect, it } from 'vitest';

import { validateGroupLifecyclePolicyInputShape } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts';

describe('validateGroupLifecyclePolicyInputShape', () => {
    it('accepts the full current input shape', () => {
        expect(validateGroupLifecyclePolicyInputShape({
            preset: 'match',
            formation: 'phased',
            initiator: 'manager',
            manager: { selection: 'creator', count: 1 },
            establishment: {
                transports: 'rtc-preferred',
                maxConcurrentEdgeSetups: 4,
                planTrigger: { kind: 'after', settleMs: 2_000 },
                connectTrigger: { kind: 'presence', memberCount: 4, fallbackMs: 10_000 }
            },
            activation: { mode: 'threshold', successRate: 0.9, minimumViableRate: 0.5 },
            admission: { mode: 'closed', untilEpochMs: null, untilMemberCount: 8 },
            topology: { replanning: 'commanded', reconfigureLanding: 'hold' },
            data: { preActivationAppData: 'blocked-until-active' }
        })).toEqual([]);
        expect(validateGroupLifecyclePolicyInputShape({})).toEqual([]);
    });

    // The pre-move wire shape must fail loudly: silently dropping
    // establishment.initiator would resolve the group to the any-member
    // default and widen who may command it.
    it('rejects the retired establishment.initiator key', () => {
        expect(
            validateGroupLifecyclePolicyInputShape({
                establishment: { initiator: 'manager' }
            }).map((issue) => issue.message)
        ).toEqual(expect.arrayContaining([expect.stringContaining('unsupported key: initiator')]));
    });

    it('rejects keys the contract does not declare', () => {
        expect(validateGroupLifecyclePolicyInputShape({ evolution: 'auto' }).map((issue) => issue.message)).toEqual(
            expect.arrayContaining([expect.stringContaining('unsupported key: evolution')])
        );
    });

    it('rejects an unsupported trigger kind and cross-variant keys', () => {
        expect(
            validateGroupLifecyclePolicyInputShape({
                establishment: { planTrigger: { kind: 'quorum' } }
            }).map((issue) => issue.message)
        ).toEqual(expect.arrayContaining([expect.stringContaining('kind is not a supported trigger kind')]));
        expect(
            validateGroupLifecyclePolicyInputShape({
                establishment: { planTrigger: { kind: 'immediate', settleMs: 5 } }
            }).map((issue) => issue.message)
        ).toEqual(expect.arrayContaining([expect.stringContaining('unsupported key: settleMs')]));
    });

    // Omitting a variant field would otherwise clamp to the minimum and
    // silently defeat the trigger's meaning (a presence threshold that fires
    // at once).
    it('requires the per-variant trigger fields', () => {
        expect(
            validateGroupLifecyclePolicyInputShape({
                establishment: { connectTrigger: { kind: 'presence', memberCount: 8 } }
            }).map((issue) => issue.message)
        ).toEqual(expect.arrayContaining([expect.stringContaining('fallbackMs must be a finite number')]));
        expect(
            validateGroupLifecyclePolicyInputShape({
                establishment: { planTrigger: { kind: 'after' } }
            }).map((issue) => issue.message)
        ).toEqual(expect.arrayContaining([expect.stringContaining('settleMs must be a finite number')]));
    });

    it('rejects enum values outside the contract', () => {
        expect(validateGroupLifecyclePolicyInputShape({ initiator: 'nobody' }).map((issue) => issue.message)).toEqual(
            expect.arrayContaining([expect.stringContaining('initiator must be one of')])
        );
        expect(validateGroupLifecyclePolicyInputShape({ topology: { replanning: 'eventually' } }).map((issue) => issue.message)).toEqual(
            expect.arrayContaining([expect.stringContaining('replanning must be one of')])
        );
    });

    it('rejects non-object and non-string-array shapes', () => {
        expect(validateGroupLifecyclePolicyInputShape({ establishment: { planTrigger: 'manual' } }).map((issue) => issue.message)).toEqual(
            expect.arrayContaining([expect.stringContaining('planTrigger must be an object')])
        );
        expect(validateGroupLifecyclePolicyInputShape({ manager: { assignedPrincipalIds: [1] } }).map((issue) => issue.message)).toEqual(
            expect.arrayContaining([expect.stringContaining('assignedPrincipalIds must be non-empty strings')])
        );
        expect(validateGroupLifecyclePolicyInputShape({ manager: { assignedPrincipalIds: [''] } }).map((issue) => issue.message)).toEqual(
            expect.arrayContaining([expect.stringContaining('assignedPrincipalIds must be non-empty strings')])
        );
    });
});
