import type {
    GroupLifecycleState,
    GroupTopologyReplanningMode
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { resolveGroupTopologyWorkDisposition } from '@shared/api/group-lifecycle/resolve-group-topology-work-disposition.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

/**
 * Who asked for this topology work: `automatic` is the machinery's own
 * follow-up (coalesced membership deltas, RTT refreshes, reconcile sweeps);
 * `commanded` carries an application or operator intent (the reconfigure
 * family and the lifecycle transitions' follow-up enqueues).
 */
export type TopologyWorkOrigin = 'automatic' | 'commanded';

/** The replanning mode as read: an unreadable policy is its own input. */
export type GroupTopologyReplanningRead = GroupTopologyReplanningMode | 'corrupt';

export type TopologyPlanAction = 'plan' | 'publish-removal' | 'freeze';

export interface ResolveTopologyPlanActionInput {
    readonly lifecycleState: GroupLifecycleState;
    readonly replanning: GroupTopologyReplanningRead;
    readonly workOrigin: TopologyWorkOrigin;
    readonly previous: RallarOverlayTopologySnapshot | undefined;
}

/**
 * The total stage-keyed planning gate (plan slice 4b, C6): every topology
 * write path resolves one of three actions from the stage disposition.
 * `freeze` is replacement suppression, never establishment suppression — a
 * group whose planned slot is absent or tombstoned may always produce its
 * first layout (today's phased flow plans while already `connecting`, and
 * the formation deadline evaluates that plan), so only an active planned
 * row freezes. `active` follows the replanning policy: `commanded` queues
 * automatic work (the layout moves only on an application command, product
 * decision 2's table) and an unreadable policy holds automatic replanning
 * closed; `auto` and `debounced` are indistinguishable on main until
 * decision 31 lands, so both plan.
 */
export function resolveTopologyPlanAction(input: ResolveTopologyPlanActionInput): TopologyPlanAction {
    const disposition = resolveGroupTopologyWorkDisposition(input.lifecycleState);
    if (disposition === 'publish-removal') {
        return 'publish-removal';
    }
    if (disposition === 'plan') {
        return 'plan';
    }
    if (input.previous?.state !== 'active') {
        return 'plan';
    }
    if (disposition === 'freeze') {
        return 'freeze';
    }
    if (input.replanning === 'corrupt') {
        return input.workOrigin === 'automatic' ? 'freeze' : 'plan';
    }
    return input.replanning === 'commanded' && input.workOrigin === 'automatic' ? 'freeze' : 'plan';
}
