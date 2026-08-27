import type { GroupLifecycleState } from './group-lifecycle-policy.ts';

export type GroupDialLayoutRoles =
    | 'none'
    | 'planned'
    | 'accepted'
    | 'accepted-and-planned';

/**
 * The dial matrix (product decision 1). Absence never falls back to active
 * sessions for a `phased` group.
 */
const DIAL_LAYOUT_ROLES: Readonly<Record<GroupLifecycleState, GroupDialLayoutRoles>> = {
    dormant: 'none',
    forming: 'none',
    planned: 'none',
    connecting: 'planned',
    active: 'accepted',
    reconfiguring: 'accepted',
    reconnecting: 'accepted-and-planned'
};

export function resolveDialLayoutRoles(lifecycleState: GroupLifecycleState): GroupDialLayoutRoles {
    return DIAL_LAYOUT_ROLES[lifecycleState];
}
