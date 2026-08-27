import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupLifecycleTransition } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import { computeGroupLifecycleTransition } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { GroupPolicyDenied, GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type { Group, GroupSnapshot } from '@shared/api/group-types.ts';
import { denyUnlessGroupLifecycleManager } from './group-lifecycle-manager-policy.ts';
import {
    denyUnlessActiveGroupMember,
    findActorGroupMember,
    isActiveGroupOwnerOrAdmin,
    requireActiveGroup
} from './group-policy-primitives.ts';
import { denyGroupPolicy, GROUP_POLICY_ALLOWED, type GroupPolicyActor } from './group-policy-result.ts';

export interface CanMutateActiveGroupInput {
    readonly group: Group;
    readonly nowEpochMs?: number;
}

export interface ShouldPlanGroupPurgeInput {
    readonly group: Group;
    readonly nowEpochMs: number;
}

export interface CanChangeGroupLifecycleInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly targetStatus: Group['status'];
}

export interface CanCommandGroupLifecycleTransitionInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly policy: GroupLifecyclePolicy;
    readonly transition: GroupLifecycleTransition;
    readonly activeMemberPrincipalIds: readonly string[];
}

export function canMutateActiveGroup(input: CanMutateActiveGroupInput): GroupPolicyResult {
    return requireActiveGroup(input.group, input.nowEpochMs) ?? GROUP_POLICY_ALLOWED;
}

export function shouldPlanGroupPurge(input: ShouldPlanGroupPurgeInput): boolean {
    return input.group.purgeAfterEpochMs !== null &&
        input.group.purgeAfterEpochMs <= input.nowEpochMs;
}

export function canChangeGroupLifecycle(
    input: CanChangeGroupLifecycleInput
): GroupPolicyResult {
    return isActiveGroupOwnerOrAdmin(findActorGroupMember(input.snapshot, input.actor))
        ? GROUP_POLICY_ALLOWED
        : denyGroupPolicy(
            'forbidden-role',
            'Only active group owners/admins can change group lifecycle.'
        );
}

export function canCommandGroupLifecycleTransition(
    input: CanCommandGroupLifecycleTransitionInput
): GroupPolicyResult {
    const actorMember = findActorGroupMember(input.snapshot, input.actor);
    const blocked = denyUnlessActiveGroupMember(actorMember);
    if (blocked) {
        return blocked;
    }
    const authority = denyForLifecycleInitiator(input);
    if (authority) {
        return authority;
    }
    const transition = computeGroupLifecycleTransition({
        transition: input.transition,
        lifecycleState: input.snapshot.group.lifecycleState,
        formationEpoch: input.snapshot.group.formationEpoch
    });
    return transition.allowed ? GROUP_POLICY_ALLOWED : transition;
}

function denyForLifecycleInitiator(
    input: CanCommandGroupLifecycleTransitionInput
): GroupPolicyDenied | undefined {
    switch (input.policy.initiator) {
        case 'any-member':
            return undefined;
        case 'server-auto':
            return denyGroupPolicy(
                'forbidden-role',
                'Lifecycle transitions are server-initiated under this policy.'
            );
        case 'manager':
            return denyUnlessGroupLifecycleManager(
                input,
                'Only the group manager can command lifecycle transitions.'
            );
    }
}
