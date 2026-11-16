import { resolveTopologyChurnOutcome } from '@shared-test/black-box-runner/topology-churn/resolve-topology-churn-outcome.ts';
import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';
import { describe, expect, it } from 'vitest';

function toLayout(version: number): GroupLayoutIdentity {
    return { groupRevision: version, presenceRevision: version, version, state: 'active' };
}

function createPlan(version: number, plannedAtEpochMs: number, topology: RallarRtcTopologyKind): AdminRoomTopologyPlan {
    return {
        publicationId: `publication-${version}`,
        requestedAtEpochMs: plannedAtEpochMs,
        layout: toLayout(version),
        topology,
        memberCount: 8,
        degreeLimit: 3,
        plan: {
            plannedAtEpochMs,
            replaced: null,
            causes: ['join'],
            delta: {
                joinedSessionCount: 1,
                leftSessionCount: 0,
                changedSessionCount: 1,
                reroutedSessionCount: 0,
                acceptingSessionCount: 1,
                maxJoinerEdgesPerSession: 1
            },
            longestPathHops: 2,
            change: { kind: 'attach' }
        }
    };
}

// The route answers in storage-key order, so the newest plan is found by its planned instant, not its position.
const PLANS = [createPlan(3, 3_000, 'mesh'), createPlan(1, 1_000, 'tree'), createPlan(2, 2_000, 'tree')];

describe('resolveTopologyChurnOutcome', () => {
    it('converges when the newest planned record is the accepted layout', () => {
        expect(resolveTopologyChurnOutcome({ plans: PLANS, acceptedLayout: toLayout(3) }).converged).toBe(true);
    });

    it('has not converged while the accepted layout is an older record or none', () => {
        expect(resolveTopologyChurnOutcome({ plans: PLANS, acceptedLayout: toLayout(2) }).converged).toBe(false);
        expect(resolveTopologyChurnOutcome({ plans: PLANS, acceptedLayout: null }).converged).toBe(false);
    });

    it('names each kind the plans used once, in planned order', () => {
        expect(resolveTopologyChurnOutcome({ plans: PLANS, acceptedLayout: null }).topology).toEqual(['tree', 'mesh']);
    });

    it('ignores a removal without a record and has not converged on a room with no plan', () => {
        const removal: AdminRoomTopologyPlan = { ...createPlan(4, 4_000, 'star'), plan: null };

        expect(resolveTopologyChurnOutcome({ plans: [...PLANS, removal], acceptedLayout: toLayout(3) })).toEqual({
            converged: true,
            topology: ['tree', 'mesh']
        });
        expect(resolveTopologyChurnOutcome({ plans: [removal], acceptedLayout: toLayout(4) })).toEqual({
            converged: false,
            topology: []
        });
    });
});
