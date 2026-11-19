import type { BackoffGateState } from '../../resilience/backoff-gate.ts';
import type { TopologyReshapeReason } from './topology-plan-change.ts';

export const HELD_TOPOLOGY_RESHAPE_REASONS = [
    'kind-change',
    'leader-rooting'
] as const satisfies readonly TopologyReshapeReason[];
export type HeldTopologyReshapeReason = (typeof HELD_TOPOLOGY_RESHAPE_REASONS)[number];

/** Every reason either list holds, once each, in HELD_TOPOLOGY_RESHAPE_REASONS order. */
export function toMergedHeldTopologyReshapeReasons(
    first: readonly HeldTopologyReshapeReason[],
    second: readonly HeldTopologyReshapeReason[]
): readonly HeldTopologyReshapeReason[] {
    return HELD_TOPOLOGY_RESHAPE_REASONS.filter((reason) => first.includes(reason) || second.includes(reason));
}

export interface TopologyReshapeGateState {
    readonly gate: BackoffGateState;
    /** In HELD_TOPOLOGY_RESHAPE_REASONS order, no duplicates; empty when nothing is owed. */
    readonly wantedReasons: readonly HeldTopologyReshapeReason[];
}

export type TopologyReshapePermission =
    | Readonly<{ reshape: 'held'; }>
    | Readonly<{ reshape: 'allowed'; wantedReasons: readonly HeldTopologyReshapeReason[]; }>;

/**
 * The permission of work the gate does not apply to: work in a stage that does not follow the replanning policy, the
 * rebuild after a held plan's failed update, and the local planning path that stores no gate.
 */
export const UNGATED_TOPOLOGY_RESHAPE_PERMISSION: TopologyReshapePermission = { reshape: 'allowed', wantedReasons: [] };
