import type { TopologyReshapeReason } from '@shared/api/topology-plan/topology-plan-change.ts';
import type { HeldTopologyReshapeReason } from '@shared/api/topology-plan/topology-reshape-gate.ts';

export type RtcTopologyPlanDerivation =
    | Readonly<{ method: 'established'; }>
    | Readonly<{ method: 'incremental'; }>
    | Readonly<{ method: 'rebuilt'; reason: TopologyReshapeReason; }>;

export interface DerivedRtcTopologyNextHops {
    readonly nextHopsBySessionId: Record<string, readonly string[]>;
    readonly derivation: RtcTopologyPlanDerivation;
    readonly heldReshapeReasons: readonly HeldTopologyReshapeReason[];
}
