import type { GroupLifecycleState } from './group-lifecycle-policy.ts';

export type GroupTopologyWorkDisposition =
    | 'publish-removal'
    | 'plan'
    | 'freeze'
    | 'follow-replanning-policy';

/**
 * What topology work may do per stage. The freeze begins only after a
 * successful `connect` commits, and frozen stages rely on the transition's
 * unconditional follow-up enqueue to replan latest authority afterwards.
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
