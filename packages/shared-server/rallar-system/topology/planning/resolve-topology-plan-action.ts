import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type {
    GroupLifecycleState,
    GroupTopologyReplanningMode
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { resolveGroupTopologyWorkDisposition } from '@shared/api/group-lifecycle/resolve-group-topology-work-disposition.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { GroupLifecyclePolicyRead } from '../../group-state/persistence/group-lifecycle-policy-repository.ts';

/**
 * Who asked for this topology work: `automatic` is the machinery's own
 * follow-up — coalesced membership deltas, including the lifecycle
 * transitions' presence-summary follow-ups, plus RTT refreshes and
 * reconcile sweeps; `commanded` carries an application or operator intent
 * (the reconfigure family). The transitions' follow-ups ride the automatic
 * channel deliberately: under `commanded` replanning a group's
 * post-transition replan also waits for the application (C7).
 */
export type TopologyWorkOrigin = 'automatic' | 'commanded';

/** The replanning mode as read: an unreadable policy is its own input. */
export type GroupTopologyReplanningRead = GroupTopologyReplanningMode | 'corrupt';

export type TopologyPlanAction = 'plan' | 'publish-removal' | 'freeze';

/**
 * Exactly the `follow-replanning-policy` disposition row consults the
 * stored replanning mode, so this is the one gate for paying the policy
 * read — spelled off the registry so the two cannot drift.
 */
export function consultsReplanningPolicy(lifecycleState: GroupLifecycleState): boolean {
    return resolveGroupTopologyWorkDisposition(lifecycleState) === 'follow-replanning-policy';
}

/**
 * The stored policy folded to the resolver's input, owned once: a group
 * with no stored policy follows the default preset's mode, and an
 * unreadable policy stays its own input so the resolver can fail
 * automatic replanning closed.
 */
export function toGroupTopologyReplanningRead(read: GroupLifecyclePolicyRead): GroupTopologyReplanningRead {
    if (read.status === 'corrupt') {
        return 'corrupt';
    }
    return read.status === 'present'
        ? read.policy.topology.replanning
        : createDefaultGroupLifecyclePolicy().topology.replanning;
}

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
 * row freezes. `active` follows the replanning policy: `commanded` holds
 * automatic work (the layout moves only on an application command, product
 * decision 2's table) and an unreadable policy fails automatic replanning
 * closed the same way; `auto` and `debounced` are indistinguishable on
 * main until decision 31 lands, so both plan.
 */
export function resolveTopologyPlanAction(input: ResolveTopologyPlanActionInput): TopologyPlanAction {
    const disposition = resolveGroupTopologyWorkDisposition(input.lifecycleState);
    if (disposition === 'publish-removal' || disposition === 'plan') {
        return disposition;
    }
    if (input.previous?.state !== 'active') {
        return 'plan';
    }
    if (disposition === 'freeze') {
        return 'freeze';
    }
    disposition satisfies 'follow-replanning-policy';
    const automaticHeld = input.replanning === 'commanded' || input.replanning === 'corrupt';
    return automaticHeld && input.workOrigin === 'automatic' ? 'freeze' : 'plan';
}
