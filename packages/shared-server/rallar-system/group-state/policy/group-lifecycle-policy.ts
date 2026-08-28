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

/**
 * Product decision 12: one initiator policy governs every application-facing
 * group-authority command. The transitions add the state machine on top; the
 * transport valve (product decision 25) has nothing to add and uses this
 * input as it stands.
 */
export interface CanCommandGroupAuthorityInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly policy: GroupLifecyclePolicy;
    readonly activeMemberPrincipalIds: readonly string[];
}

export interface CanCommandGroupLifecycleTransitionInput extends CanCommandGroupAuthorityInput {
    readonly transition: GroupLifecycleTransition;
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

export function canCommandGroupAuthority(
    input: CanCommandGroupAuthorityInput
): GroupPolicyResult {
    const blocked = denyUnlessActiveGroupMember(findActorGroupMember(input.snapshot, input.actor));
    if (blocked) {
        return blocked;
    }
    return denyForGroupAuthorityInitiator(input) ?? GROUP_POLICY_ALLOWED;
}

export function canCommandGroupLifecycleTransition(
    input: CanCommandGroupLifecycleTransitionInput
): GroupPolicyResult {
    const authority = canCommandGroupAuthority(input);
    if (!authority.allowed) {
        return authority;
    }
    const transition = computeGroupLifecycleTransition({
        transition: input.transition,
        lifecycleState: input.snapshot.group.lifecycleState,
        formationEpoch: input.snapshot.group.formationEpoch
    });
    if (!transition.allowed) {
        return transition;
    }
    return denyForExhaustedFormationSeries(input) ?? GROUP_POLICY_ALLOWED;
}

/**
 * Product decision 37: the attempt budget bounds one formation series, and
 * spending it is terminal for automation. `start` is the series' only
 * entrance, so the budget is enforced there; an explicit `reset` — which
 * zeroes the count — is the only way past it.
 */
function denyForExhaustedFormationSeries(
    input: CanCommandGroupLifecycleTransitionInput
): GroupPolicyDenied | undefined {
    const { group } = input.snapshot;
    if (input.transition !== 'start') {
        return undefined;
    }
    if (group.formationAttemptCount < input.policy.activation.maxFormationAttempts) {
        return undefined;
    }
    return denyGroupPolicy(
        'formation-attempts-exhausted',
        `Formation attempts are exhausted (${group.formationAttemptCount} of ` +
            `${input.policy.activation.maxFormationAttempts}); reset the group to start a new series.`
    );
}

function denyForGroupAuthorityInitiator(
    input: CanCommandGroupAuthorityInput
): GroupPolicyDenied | undefined {
    switch (input.policy.initiator) {
        case 'any-member':
            return undefined;
        case 'server-auto':
            return denyGroupPolicy(
                'forbidden-role',
                'Group authority commands are server-initiated under this policy.'
            );
        case 'manager':
            return denyUnlessGroupLifecycleManager(
                input,
                'Only the group manager can command group authority.'
            );
        default:
            return denyUnknownInitiator(input.policy.initiator);
    }
}

// A widened initiator union must add its arm above or fail closed here —
// falling off the switch would read as "no authority objection".
function denyUnknownInitiator(initiator: never): GroupPolicyDenied {
    return denyGroupPolicy(
        'forbidden-role',
        `Unknown group authority initiator policy: ${String(initiator)}.`
    );
}
