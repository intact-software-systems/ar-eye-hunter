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

/** The permission of work the gate does not apply to: commanded work, and the local planning path that stores no gate. */
export const UNGATED_TOPOLOGY_RESHAPE_PERMISSION: TopologyReshapePermission = { reshape: 'allowed', wantedReasons: [] };
