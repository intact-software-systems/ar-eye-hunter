import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

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
    /** The stored policy of a group whose stage follows the replanning policy. */
    readonly lifecyclePolicy: GroupLifecyclePolicyRead;
    /** The server-wide window every group coalesced through before per-group windows existed. */
    readonly serverDebounceMs: number;
}

/**
 * Product decision 31: `auto` carries no policy window and keeps the server's,
 * unbounded, so it replans on the first opportunity after a change;
 * `debounced` carries the policy's window and maximum wait; `commanded`
 * coalesces its commanded follow-ups under that same policy window. An
 * unreadable policy offers no window — the planner already holds its
 * automatic replans closed — so its merges keep the server window.
 */
export function resolveTopologyReplanWindow(input: ResolveTopologyReplanWindowInput): TopologyReplanWindow {
    const serverWindow: TopologyReplanWindow = { debounceMs: input.serverDebounceMs, maxWaitMs: null };
    switch (input.lifecyclePolicy.status) {
        case 'corrupt':
            return serverWindow;
        case 'absent':
            return toPolicyWindow(createDefaultGroupLifecyclePolicy(), serverWindow);
        case 'present':
            return toPolicyWindow(input.lifecyclePolicy.policy, serverWindow);
    }
}

function toPolicyWindow(policy: GroupLifecyclePolicy, serverWindow: TopologyReplanWindow): TopologyReplanWindow {
    const { topology } = policy;
    switch (topology.replanning) {
        case 'auto':
            return serverWindow;
        case 'debounced':
        case 'commanded':
            return { debounceMs: topology.debounceWindowMs, maxWaitMs: topology.maxReplanWaitMs };
    }
}
