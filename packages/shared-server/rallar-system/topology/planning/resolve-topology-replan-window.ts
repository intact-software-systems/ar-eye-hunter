import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

import type { GroupLifecyclePolicyRead } from '../../group-state/persistence/group-lifecycle-policy-repository.ts';

export interface TopologyReplanWindow {
    /** The wait after the latest change before a replan is due. */
    readonly debounceMs: number;
    /**
     * The bound on how long merged changes may keep extending that wait,
     * measured from the first change of the series; null leaves the
     * extension unbounded.
     */
    readonly maxWaitMs: number | null;
}

export interface ResolveTopologyReplanWindowInput {
    /** The stored policy, or null when the stage does not follow the replanning policy. */
    readonly lifecyclePolicy: GroupLifecyclePolicyRead | null;
    /** The server-wide window every group coalesced through before per-group windows existed. */
    readonly serverDebounceMs: number;
}

/**
 * Product decision 31: `debounced` carries the policy's window and maximum
 * wait, `auto` carries no policy window and keeps the server's while its
 * extension is still bounded, and `commanded` coalesces its commanded
 * follow-ups under the policy's window. A stage outside the policy and an
 * unreadable policy keep the server window unbounded, as before.
 */
export function resolveTopologyReplanWindow(input: ResolveTopologyReplanWindowInput): TopologyReplanWindow {
    if (input.lifecyclePolicy === null || input.lifecyclePolicy.status === 'corrupt') {
        return { debounceMs: input.serverDebounceMs, maxWaitMs: null };
    }
    const policy = input.lifecyclePolicy.status === 'present'
        ? input.lifecyclePolicy.policy
        : createDefaultGroupLifecyclePolicy();
    const topology = policy.topology;
    return {
        debounceMs: topology.replanning === 'auto' ? input.serverDebounceMs : topology.debounceWindowMs,
        maxWaitMs: topology.maxReplanWaitMs
    };
}
