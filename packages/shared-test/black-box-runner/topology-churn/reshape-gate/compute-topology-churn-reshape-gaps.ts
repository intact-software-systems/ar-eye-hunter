import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';

import { toPlannedTopologyPlans } from '../to-planned-topology-plans.ts';

/** The gaps between consecutive reshape plans of one room, from the records' plannedAtEpochMs; empty for fewer than two. */
export function computeTopologyChurnReshapeGaps(plans: readonly AdminRoomTopologyPlan[]): readonly number[] {
    const reshapedAtEpochMs = toPlannedTopologyPlans(plans)
        .filter((entry) => entry.plan.change?.kind === 'reshape')
        .map((entry) => entry.plan.plannedAtEpochMs);
    return reshapedAtEpochMs.slice(1).map((epochMs, index) => epochMs - reshapedAtEpochMs[index]);
}
