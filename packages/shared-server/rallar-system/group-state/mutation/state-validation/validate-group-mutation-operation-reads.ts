import { requireNonEmptyString, requireOneOf } from '../../group-state-validation-primitives.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import {
    isGroupAdmissionDecisionOperation,
    isGroupAdmissionPolicyReadOperation,
    isGroupLifecycleTransitionOperation
} from '../group-mutation-contracts.ts';

export function validateGroupMutationOperationReads(
    read: GroupMutationRead,
    command: GroupMutationCommand
): void {
    validateLifecyclePolicyRead(read, command);
    validateActiveMemberPrincipalIdsRead(read, command);
}

/**
 * The policy read is loaded exactly for lifecycle transitions and operations
 * whose admission policy must participate in the decision.
 */
function validateLifecyclePolicyRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): void {
    if (
        isGroupLifecycleTransitionOperation(command.operation) ||
        isGroupAdmissionPolicyReadOperation(command.operation)
    ) {
        if (read.lifecyclePolicy === null) {
            throw new TypeError('Group mutation read is missing the lifecycle policy read');
        }
        requireOneOf(
            read.lifecyclePolicy.status,
            ['absent', 'present', 'corrupt'],
            'Group mutation lifecycle policy status'
        );
        return;
    }
    if (read.lifecyclePolicy !== null) {
        throw new TypeError('Group mutation read must not carry a lifecycle policy for this operation');
    }
}

/**
 * The full active roster is loaded only when a lifecycle transition pins its
 * electorate or an admission decision resolves current managers.
 */
function validateActiveMemberPrincipalIdsRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): void {
    if (
        isGroupLifecycleTransitionOperation(command.operation) ||
        isGroupAdmissionDecisionOperation(command.operation)
    ) {
        if (read.activeMemberPrincipalIds === null) {
            throw new TypeError('Group mutation read is missing the active member principal ids');
        }
        for (const principalId of read.activeMemberPrincipalIds) {
            requireNonEmptyString(principalId, 'Group mutation active member principal id');
        }
        return;
    }
    if (read.activeMemberPrincipalIds !== null) {
        throw new TypeError(
            'Group mutation read must not carry active member principal ids for this operation'
        );
    }
    if (
        !isGroupLifecycleTransitionOperation(command.operation) &&
        read.plannedLayoutIdentity !== null
    ) {
        throw new TypeError('Group mutation read carries a planned layout for a non-lifecycle operation');
    }
}
