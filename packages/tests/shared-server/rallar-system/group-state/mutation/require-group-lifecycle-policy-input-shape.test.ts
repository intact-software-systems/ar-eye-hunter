import { describe, expect, it } from 'vitest';

import { requireGroupLifecyclePolicyInputShape } from '@shared-server/rallar-system/group-state/mutation/command-validation/require-group-lifecycle-policy-input-shape.ts';

describe('requireGroupLifecyclePolicyInputShape', () => {
    it('accepts the full current input shape', () => {
        expect(() =>
            requireGroupLifecyclePolicyInputShape({
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
            })
        ).not.toThrow();
        expect(() => requireGroupLifecyclePolicyInputShape({})).not.toThrow();
    });

    // The pre-move wire shape must fail loudly: silently dropping
    // establishment.initiator would resolve the group to the any-member
    // default and widen who may command it.
    it('rejects the retired establishment.initiator key', () => {
        expect(() =>
            requireGroupLifecyclePolicyInputShape({
                establishment: { initiator: 'manager' }
            })
        ).toThrow('unsupported key: initiator');
    });

    it('rejects keys the contract does not declare', () => {
        expect(() => requireGroupLifecyclePolicyInputShape({ evolution: 'auto' }))
            .toThrow('unsupported key: evolution');
    });

    it('rejects an unsupported trigger kind and cross-variant keys', () => {
        expect(() =>
            requireGroupLifecyclePolicyInputShape({
                establishment: { planTrigger: { kind: 'quorum' } }
            })
        ).toThrow('kind is not a supported trigger kind');
        expect(() =>
            requireGroupLifecyclePolicyInputShape({
                establishment: { planTrigger: { kind: 'immediate', settleMs: 5 } }
            })
        ).toThrow('unsupported key: settleMs');
    });

    // Omitting a variant field would otherwise clamp to the minimum and
    // silently defeat the trigger's meaning (a presence threshold that fires
    // at once).
    it('requires the per-variant trigger fields', () => {
        expect(() =>
            requireGroupLifecyclePolicyInputShape({
                establishment: { connectTrigger: { kind: 'presence', memberCount: 8 } }
            })
        ).toThrow('fallbackMs must be a finite number');
        expect(() =>
            requireGroupLifecyclePolicyInputShape({
                establishment: { planTrigger: { kind: 'after' } }
            })
        ).toThrow('settleMs must be a finite number');
    });

    it('rejects enum values outside the contract', () => {
        expect(() => requireGroupLifecyclePolicyInputShape({ initiator: 'nobody' }))
            .toThrow('initiator must be one of');
        expect(() => requireGroupLifecyclePolicyInputShape({ topology: { replanning: 'eventually' } })).toThrow('replanning must be one of');
    });

    it('rejects non-object and non-string-array shapes', () => {
        expect(() => requireGroupLifecyclePolicyInputShape({ establishment: { planTrigger: 'manual' } })).toThrow('planTrigger must be an object');
        expect(() => requireGroupLifecyclePolicyInputShape({ manager: { assignedPrincipalIds: [1] } })).toThrow(
            'assignedPrincipalIds must be non-empty strings'
        );
        expect(() => requireGroupLifecyclePolicyInputShape({ manager: { assignedPrincipalIds: [''] } })).toThrow(
            'assignedPrincipalIds must be non-empty strings'
        );
    });
});
