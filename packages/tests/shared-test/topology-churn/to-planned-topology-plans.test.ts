import { toPlannedTopologyPlans } from '@shared-test/black-box-runner/topology-churn/to-planned-topology-plans.ts';
import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import { describe, expect, it } from 'vitest';

function createPlan(version: number, plannedAtEpochMs: number): AdminRoomTopologyPlan {
    return {
        publicationId: `publication-${version}`,
        requestedAtEpochMs: plannedAtEpochMs,
        layout: { groupRevision: version, presenceRevision: version, version, state: 'active' },
        topology: 'tree',
        memberCount: 4,
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
            longestPathHops: 2
        }
    };
}

describe('toPlannedTopologyPlans', () => {
    it('keeps the plans with a record, in planned order rather than the route\'s storage order', () => {
        const removal: AdminRoomTopologyPlan = { ...createPlan(9, 500), plan: null };
        const planned = toPlannedTopologyPlans([createPlan(3, 3_000), removal, createPlan(1, 1_000), createPlan(2, 2_000)]);

        expect(planned.map((entry) => entry.publicationId)).toEqual(['publication-1', 'publication-2', 'publication-3']);
        expect(planned.map((entry) => entry.plan.plannedAtEpochMs)).toEqual([1_000, 2_000, 3_000]);
    });

    it('answers no plans for a room with only removals', () => {
        expect(toPlannedTopologyPlans([{ ...createPlan(1, 1_000), plan: null }])).toEqual([]);
    });
});
