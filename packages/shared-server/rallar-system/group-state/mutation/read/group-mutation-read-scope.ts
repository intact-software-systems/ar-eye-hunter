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
        operation === 'applyPlannedLayout'
    );
}

/**
 * The operations that need the full active roster: a transition pins its
 * electorate, an admission decision resolves current managers, and both
 * group-authority families resolve the manager initiator from it.
 */
export function readsGroupActiveMemberPrincipalIds(
    operation: GroupMutationCommand['operation']
): boolean {
    return (
        isGroupLifecycleTransitionOperation(operation) ||
        isGroupTransportOperation(operation) ||
        isGroupAdmissionDecisionOperation(operation)
    );
}

/**
 * True when the command's compute consults the stored layout rows: every
 * activation reads them for the promotion effect (operator activations
 * included), and a layout-fenced command reads the planned row for its
 * fence and its commit-time re-assertion.
 */
export function readsGroupLayoutRows(command: GroupMutationCommand): boolean {
    return command.operation === 'activateGroup' || isLayoutFencedGroupMutationCommand(command);
}

/**
 * The accepted row is read only by the commands that can promote: a fenced
 * command that never promotes (connect, decision 42) consults the planned
 * row alone, so it does not pay for a slot it cannot consult.
 */
export function readsAcceptedLayoutRow(command: GroupMutationCommand): boolean {
    return command.operation === 'activateGroup' || command.operation === 'applyPlannedLayout';
}
