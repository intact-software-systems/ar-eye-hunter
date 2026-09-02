import { Either } from '@shared/resilience/Either.ts';
import type { GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { computeApplyPlannedLayout } from '../aggregate/compute-apply-planned-layout.ts';
import {
    computeCreate,
    computeDirector,
    computeRotateJoinCode,
    computeUpdate
} from '../aggregate/compute-group-aggregate-mutation.ts';
import { computeGroupTransportMutation } from '../aggregate/compute-group-transport-mutation.ts';
import { computeLifecycleTransition } from '../aggregate/compute-lifecycle-transition.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { rejected } from '../group-mutation-result.ts';
import {
    computeDeclineGroupAdmission,
    computeGrantGroupAdmission
} from '../membership/compute-group-admission-mutation.ts';
import {
    computeGovernedMember,
    computeInvite,
    computeJoin,
    computeRevokeInvite,
    computeTransfer,
    computeUpsertMember
} from '../membership/compute-group-membership-mutation.ts';
import { computeConnectGroupPresence } from '../presence/compute-connect-group-presence.ts';
import { computeDisconnectGroupPresence } from '../presence/compute-disconnect-group-presence.ts';
import { computeHeartbeatGroupPresence } from '../presence/compute-heartbeat-group-presence.ts';
import { probeGroupMutationIdempotency } from '../probe-group-mutation-idempotency.ts';

export interface GroupMutationInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
}

export function computeGroupMutation(input: GroupMutationInput): GroupMutationComputed {
    return unwrapGroupMutationComputation(computeGroupMutationDecision(input));
}

/** The command, read and facts are validated by both public callers before this pure decision. */
export function computeGroupMutationDecision(
    input: GroupMutationInput
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    const { command, read, facts } = input;
    const idempotency = probeGroupMutationIdempotency(command, read, facts.commandHash);
    if (idempotency.outcome !== 'miss') {
        return Either.ofRight(
            idempotency.outcome === 'replay'
                ? { ...idempotency, rejectionCode: null }
                : idempotency
        );
    }
    if (command.operation !== 'createGroup' && read.group === null) {
        return Either.ofRight(rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Group not found: ${command.aggregateRef.groupId}`
        }));
    }

    const computed = computeFreshGroupMutation(command, read, facts);
    return computed instanceof Either ? computed : Either.ofRight(computed);
}

function computeFreshGroupMutation(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed | Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    switch (command.operation) {
        case 'createGroup':
            return computeCreate(command, read, facts);
        case 'updateGroup':
            return computeUpdate(command, read, facts);
        case 'appointDirector':
            return computeDirector(command, read, facts);
        case 'planGroupLayout':
        case 'connectGroup':
        case 'startGroupFormation':
        case 'resetGroupFormation':
        case 'activateGroup':
        case 'reconfigureGroup':
        case 'failGroupFormation':
            return computeLifecycleTransition(command, read, facts);
        case 'applyPlannedLayout':
            return computeApplyPlannedLayout(command, read, facts);
        case 'pauseGroupTransport':
        case 'resumeGroupTransport':
            return computeGroupTransportMutation(command, read, facts);
        case 'joinGroup':
        case 'acceptGroupInvite':
            return computeJoin(command, read, facts);
        case 'createGroupInvite':
            return computeInvite(command, read, facts);
        case 'revokeGroupInvite':
            return computeRevokeInvite(command, read, facts);
        case 'grantGroupAdmission':
            return computeGrantGroupAdmission(command, read, facts);
        case 'declineGroupAdmission':
            return computeDeclineGroupAdmission(command, read, facts);
        case 'rotateGroupJoinCode':
            return computeRotateJoinCode(command, read, facts);
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'setGroupMemberRole':
            return computeGovernedMember(command, read, facts);
        case 'transferGroupOwnership':
            return computeTransfer(command, read, facts);
        case 'upsertMember':
            return computeUpsertMember(command, read, facts);
        case 'connectPresence':
            return computeConnectGroupPresence(command, read, facts);
        case 'heartbeatPresence':
            return computeHeartbeatGroupPresence(command, read, facts);
        case 'disconnectPresence':
            return computeDisconnectGroupPresence(command, read, facts);
    }
}

function unwrapGroupMutationComputation(
    result: GroupMutationComputed | Either<readonly GroupStateValidationIssue[], GroupMutationComputed>
): GroupMutationComputed {
    if (!(result instanceof Either)) {
        return result;
    }
    if (result.left !== undefined) {
        throw result.left[0].cause;
    }
    return result.right!;
}
