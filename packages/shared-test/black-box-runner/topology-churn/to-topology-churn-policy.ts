import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type {
    GroupTopologyPolicy,
    GroupTopologyReplanningMode
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

const MANAGED_TOPOLOGY = resolveGroupLifecyclePolicyPreset('managed').topology;

/** A debounced room debounces and gates reshapes as the `managed` preset does; everything else is the optimistic default. */
export function toTopologyChurnPolicy(replanning: GroupTopologyReplanningMode): Partial<GroupTopologyPolicy> {
    return replanning === 'debounced'
        ? {
            replanning,
            debounceWindowMs: MANAGED_TOPOLOGY.debounceWindowMs,
            maxReplanWaitMs: MANAGED_TOPOLOGY.maxReplanWaitMs,
            reshapeMinIntervalMs: MANAGED_TOPOLOGY.reshapeMinIntervalMs,
            reshapeMaxIntervalMs: MANAGED_TOPOLOGY.reshapeMaxIntervalMs
        }
        : { replanning };
}
