import type { TopologyReshapeReason } from '@shared/api/topology-plan/topology-plan-change.ts';

export type RtcTopologyPlanDerivation =
    | Readonly<{ method: 'established'; }>
    | Readonly<{ method: 'incremental'; }>
    | Readonly<{ method: 'rebuilt'; reason: TopologyReshapeReason; }>;

export interface DerivedRtcTopologyNextHops {
    readonly nextHopsBySessionId: Record<string, readonly string[]>;
    readonly derivation: RtcTopologyPlanDerivation;
}
