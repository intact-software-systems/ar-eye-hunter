import type { GroupMutationCommand } from '../group-mutation-contracts.ts';
import {
    isGroupAdmissionDecisionOperation,
    isGroupAdmissionPolicyReadOperation,
    isGroupLifecycleTransitionOperation,
    isGroupTransportOperation,
    isLayoutFencedGroupMutationCommand
} from '../group-mutation-contracts.ts';

/**
 * What each command's compute is allowed to consult. The read path loads
 * exactly this and the read validator rejects exactly the complement, so
 * both key on the same owner and a one-sided edit is impossible.
 */

/**
 * The operations whose compute consults the stored lifecycle policy: the
 * transitions and the transport commands read its initiator (product
 * decision 12's single group-authority policy), the promotion reads the
 * replanning landing, and the admission surfaces read the admission mode.
 */
export function readsGroupLifecyclePolicy(
    operation: GroupMutationCommand['operation']
): boolean {
    return (
        isGroupLifecycleTransitionOperation(operation) ||
        isGroupTransportOperation(operation) ||
        isGroupAdmissionPolicyReadOperation(operation) ||
        operation === 'setGroupMemberRole' || operation === 'transferGroupOwnership' ||
        operation === 'applyPlannedLayout' ||
        // The status write bands against the activation rates and reads the
        // replanning mode for its remediation axis.
        operation === 'updateGroupActivationStatus'
    );
}

/** Complete member rows support participation capacity as well as authority and electorate decisions. */
export function readsGroupActiveMembers(
    operation: GroupMutationCommand['operation']
): boolean {
    return readsGroupActiveMemberPrincipalIds(operation) ||
        isGroupAdmissionPolicyReadOperation(operation) ||
        operation === 'setGroupMemberRole' || operation === 'transferGroupOwnership' ||
        operation === 'updateGroup';
}

/** Sorted player identities are needed only for electorate and manager decisions. */
export function readsGroupActiveMemberPrincipalIds(
    operation: GroupMutationCommand['operation']
): boolean {
    return isGroupLifecycleTransitionOperation(operation) ||
        isGroupTransportOperation(operation) ||
        isGroupAdmissionDecisionOperation(operation);
}

/**
 * True when the command's compute consults the stored layout rows: every
 * activation reads them for the promotion effect (operator activations
 * included), a layout-fenced command reads the planned row for its fence and
 * its commit-time re-assertion, and a `reconfigure` reads it to name the
 * candidate its connect latch supersedes (plan slice 11d). The reconfigure
 * takes no fence from it, so it adds a point read and no conflict surface —
 * and only on a commanded path that already reads the stored policy.
 */
export function readsGroupLayoutRows(command: GroupMutationCommand): boolean {
    return command.operation === 'activateGroup' ||
        command.operation === 'resetGroupFormation' ||
        command.operation === 'reconfigureGroup' ||
        isLayoutFencedGroupMutationCommand(command);
}

/**
 * The accepted row is read only by the commands that can promote: a fenced
 * command that never promotes (connect, decision 42) consults the planned
 * row alone, so it does not pay for a slot it cannot consult.
 */
export function readsAcceptedLayoutRow(command: GroupMutationCommand): boolean {
    return command.operation === 'activateGroup' ||
        command.operation === 'applyPlannedLayout' ||
        command.operation === 'resetGroupFormation';
}

/**
 * The target's publication-grant row is read exactly by the grant commands, which rewrite it, by the departures,
 * which delete it in their own batch (D485): a remove, a ban, or an upsert out of active, a leave among them, and by a
 * create, whose creator's row may survive an expired incarnation (D494). Join, admission, unban and role changes never
 * consult it.
 */
export function readsTargetPublicationGrant(command: GroupMutationCommand): boolean {
    return command.operation === 'createGroup' ||
        command.operation === 'grantGroupPublication' ||
        command.operation === 'revokeGroupPublication' ||
        command.operation === 'removeGroupMember' ||
        command.operation === 'banGroupMember' ||
        (command.operation === 'upsertMember' && command.input.status !== 'active');
}
