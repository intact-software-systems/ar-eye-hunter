import { requireNonEmptyString, requireOneOf } from '../../group-state-validation-primitives.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import {
    readsGroupActiveMemberPrincipalIds,
    readsGroupLayoutRows,
    readsGroupLifecyclePolicy
} from '../read/group-mutation-read-scope.ts';

export function validateGroupMutationOperationReads(
    read: GroupMutationRead,
    command: GroupMutationCommand
): void {
    validateLifecyclePolicyRead(read, command);
    validateActiveMemberPrincipalIdsRead(read, command);
    validatePlannedLayoutIdentityRead(read, command);
}

/**
 * The layout rows are read exactly for the promotion-capable and
 * layout-fenced commands; null stays legal there because the reader may find
 * no stored row.
 */
function validatePlannedLayoutIdentityRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): void {
    if (readsGroupLayoutRows(command)) {
        return;
    }
    if (read.plannedLayoutRow !== null) {
        throw new TypeError('Group mutation read carries a planned layout for an unfenced command');
    }
    if (read.acceptedLayoutRow !== null) {
        throw new TypeError('Group mutation read carries an accepted layout for an unfenced command');
    }
}

/**
 * The policy read is loaded exactly for the operations whose compute
 * consults the stored policy — the read path and this validator share one
 * owner, so a one-sided edit cannot leave the read missing or unexpected.
 */
function validateLifecyclePolicyRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): void {
    if (readsGroupLifecyclePolicy(command.operation)) {
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
 * The full active roster is loaded only when a transition pins its
 * electorate, an admission decision resolves current managers, or a
 * group-authority command resolves the manager initiator.
 */
function validateActiveMemberPrincipalIdsRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): void {
    if (readsGroupActiveMemberPrincipalIds(command.operation)) {
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
}
