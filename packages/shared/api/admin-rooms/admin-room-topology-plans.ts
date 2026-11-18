import type { GroupLayoutIdentity } from '../group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '../group-types.ts';
import type { RallarRtcTopologyKind } from '../overlay-topology.ts';
import type { RtcTopologyPlanRecord } from '../topology-plan/rtc-topology-plan-record.ts';
import type { TopologyReshapeGateState } from '../topology-plan/topology-reshape-gate.ts';

export const ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT = 100;

export interface AdminRoomTopologyPlansRequest {
    readonly roomRef: GroupRef;
    readonly limit: number;
    readonly afterPublicationId: string | null;
}

export interface AdminRoomTopologyPlan {
    readonly publicationId: string;
    readonly requestedAtEpochMs: number;
    readonly layout: GroupLayoutIdentity;
    readonly topology: RallarRtcTopologyKind;
    readonly memberCount: number;
    readonly degreeLimit: number;
    readonly plan: RtcTopologyPlanRecord | null;
}

export interface AdminRoomReshapeGate extends TopologyReshapeGateState {
    /** The wait in force, from the count of held passes and the policy's bounds as read. */
    readonly intervalMs: number;
    /** `gate.lastPassAtEpochMs + intervalMs`; null before the room's first reshape. */
    readonly opensAtEpochMs: number | null;
}

/** Plans arrive in storage-key order, not time order; readers sort by `plan.plannedAtEpochMs`. */
export interface AdminRoomTopologyPlansResponse {
    readonly roomRef: GroupRef;
    readonly observedAtEpochMs: number;
    readonly plans: readonly AdminRoomTopologyPlan[];
    readonly nextAfterPublicationId: string | null;
    /** Null when the room stores no reshape gate. */
    readonly reshapeGate: AdminRoomReshapeGate | null;
}
