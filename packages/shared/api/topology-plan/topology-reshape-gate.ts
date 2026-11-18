import type { BackoffGateState } from '../../resilience/backoff-gate.ts';

export const HELD_TOPOLOGY_RESHAPE_REASONS = ['kind-change', 'leader-rooting'] as const;
export type HeldTopologyReshapeReason = (typeof HELD_TOPOLOGY_RESHAPE_REASONS)[number];

export interface TopologyReshapeGateState {
    readonly gate: BackoffGateState;
    /** In HELD_TOPOLOGY_RESHAPE_REASONS order, no duplicates; empty when nothing is owed. */
    readonly wantedReasons: readonly HeldTopologyReshapeReason[];
}

export type TopologyReshapePermission =
    | Readonly<{ reshape: 'held'; }>
    | Readonly<{ reshape: 'allowed'; wantedReasons: readonly HeldTopologyReshapeReason[]; }>;
