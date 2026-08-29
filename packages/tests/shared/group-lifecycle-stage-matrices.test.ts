import { describe, expect, it } from 'vitest';

import { blocksGroupPreActivationData } from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { computeGroupDataGate } from '@shared/api/group-lifecycle/compute-group-data-gate.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { resolveDialLayoutRoles } from '@shared/api/group-lifecycle/resolve-dial-layout-roles.ts';
import { resolveGroupTopologyWorkDisposition } from '@shared/api/group-lifecycle/resolve-group-topology-work-disposition.ts';

// The dial matrix of product decision 1: dialing is a total function of the
// stage, and absence never falls back to active sessions.
describe('resolveDialLayoutRoles', () => {
    it.each([
        { lifecycleState: 'dormant' as const, roles: 'none' },
        { lifecycleState: 'forming' as const, roles: 'none' },
        { lifecycleState: 'planned' as const, roles: 'none' },
        { lifecycleState: 'connecting' as const, roles: 'planned' },
        { lifecycleState: 'active' as const, roles: 'accepted' },
        { lifecycleState: 'reconfiguring' as const, roles: 'accepted' },
        { lifecycleState: 'reconnecting' as const, roles: 'accepted-and-planned' }
    ])('$lifecycleState dials $roles', (row) => {
        expect(resolveDialLayoutRoles(row.lifecycleState)).toBe(row.roles);
    });
});

describe('resolveGroupTopologyWorkDisposition', () => {
    it.each([
        { lifecycleState: 'dormant' as const, disposition: 'publish-removal' },
        { lifecycleState: 'forming' as const, disposition: 'publish-removal' },
        { lifecycleState: 'planned' as const, disposition: 'plan' },
        { lifecycleState: 'connecting' as const, disposition: 'freeze' },
        { lifecycleState: 'active' as const, disposition: 'follow-replanning-policy' },
        { lifecycleState: 'reconfiguring' as const, disposition: 'plan' },
        { lifecycleState: 'reconnecting' as const, disposition: 'freeze' }
    ])('$lifecycleState topology work is $disposition', (row) => {
        expect(resolveGroupTopologyWorkDisposition(row.lifecycleState)).toBe(row.disposition);
    });
});

describe('computeGroupDataGate', () => {
    // The forward gate closes while no layout has been accepted in the
    // current series and reopens for the reconfiguration stages, where the
    // accepted layout keeps carrying traffic (product decision 25).
    it.each([
        { lifecycleState: 'dormant' as const, gate: 'blocked' },
        { lifecycleState: 'forming' as const, gate: 'blocked' },
        { lifecycleState: 'planned' as const, gate: 'blocked' },
        { lifecycleState: 'connecting' as const, gate: 'blocked' },
        { lifecycleState: 'active' as const, gate: 'flows' },
        { lifecycleState: 'reconfiguring' as const, gate: 'flows' },
        { lifecycleState: 'reconnecting' as const, gate: 'flows' }
    ])('blocked-until-active in $lifecycleState reads $gate', (row) => {
        expect(computeGroupDataGate({
            lifecycleState: row.lifecycleState,
            transportState: 'flowing',
            preActivationAppData: 'blocked-until-active'
        })).toBe(row.gate);
    });

    it('the halt refuses data in every stage under every data policy', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            for (const preActivationAppData of ['allowed', 'blocked-until-active'] as const) {
                expect(computeGroupDataGate({
                    lifecycleState,
                    transportState: 'halted',
                    preActivationAppData
                })).toBe('halted');
            }
        }
    });

    it('an allowed policy flows in every stage while transport is flowing', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            expect(computeGroupDataGate({
                lifecycleState,
                transportState: 'flowing',
                preActivationAppData: 'allowed'
            })).toBe('flows');
        }
    });

    it('the live block predicate matches the product forward gate in every stage', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            const liveBlocks = blocksGroupPreActivationData(lifecycleState);
            const productBlocks = computeGroupDataGate({
                lifecycleState,
                transportState: 'flowing',
                preActivationAppData: 'blocked-until-active'
            }) === 'blocked';
            expect(liveBlocks, lifecycleState).toBe(productBlocks);
        }
    });
});
