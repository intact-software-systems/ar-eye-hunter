import type { GroupLifecycleState } from './group-lifecycle-policy.ts';

export type GroupTopologyWorkDisposition =
    | 'publish-removal'
    | 'plan'
    | 'freeze'
    | 'follow-replanning-policy';

/**
 * What topology work may do per stage. `dormant` and `forming` publish the
 * removal tombstone; `planned` and `reconfiguring` may plan and publish a held
 * candidate; `connecting` and `reconnecting` freeze the planned identity being
 * dialed and rely on the transition's unconditional follow-up enqueue to
 * replan latest authority; `active` defers to the replanning policy. The
 * freeze begins only after a successful `connect` commits.
 */
const TOPOLOGY_WORK_DISPOSITIONS: Readonly<Record<GroupLifecycleState, GroupTopologyWorkDisposition>> = {
    dormant: 'publish-removal',
    forming: 'publish-removal',
    planned: 'plan',
    connecting: 'freeze',
    active: 'follow-replanning-policy',
    reconfiguring: 'plan',
    reconnecting: 'freeze'
};

export function resolveGroupTopologyWorkDisposition(
    lifecycleState: GroupLifecycleState
): GroupTopologyWorkDisposition {
    return TOPOLOGY_WORK_DISPOSITIONS[lifecycleState];
}
