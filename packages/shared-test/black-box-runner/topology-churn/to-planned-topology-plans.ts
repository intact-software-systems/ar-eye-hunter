import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import type { RtcTopologyPlanRecord } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';

export interface PlannedTopologyPlan extends AdminRoomTopologyPlan {
    readonly plan: RtcTopologyPlanRecord;
}

/** The route answers in storage-key order and includes removals; figures need the records in planned order. */
export function toPlannedTopologyPlans(plans: readonly AdminRoomTopologyPlan[]): readonly PlannedTopologyPlan[] {
    return plans
        .flatMap((entry) => entry.plan === null ? [] : [{ ...entry, plan: entry.plan }])
        .sort((left, right) => left.plan.plannedAtEpochMs - right.plan.plannedAtEpochMs);
}
