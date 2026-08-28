import { computeApplyPlannedLayout } from '../aggregate/compute-apply-planned-layout.ts';
import {
    computeCreate,
    computeDirector,
    computeRotateJoinCode,
    computeUpdate
} from '../aggregate/compute-group-aggregate-mutation.ts';
import { computeGroupTransportMutation } from '../aggregate/compute-group-transport-mutation.ts';
import { computeLifecycleTransition } from '../aggregate/compute-lifecycle-transition.ts';
import { validateGroupMutationAuthority } from '../command-validation/validate-group-mutation-authority.ts';
import { validateGroupMutationCommand } from '../command-validation/validate-group-mutation-command.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
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
import { validateGroupMutationFacts } from '../state-validation/validate-group-mutation-facts.ts';
import { validateGroupMutationRead } from '../state-validation/validate-group-mutation-read.ts';

export function computeGroupMutation(
    input: Readonly<{
        command: GroupMutationCommand;
        read: GroupMutationRead;
        facts: GroupMutationFacts;
    }>
): GroupMutationComputed {
    const { command, read, facts } = input;
    validateGroupMutationCommand(command);
    validateGroupMutationRead(read, command);
    validateGroupMutationFacts(facts);
    validateGroupMutationAuthority(command, facts);
    const idempotency = probeGroupMutationIdempotency(command, read, facts.commandHash);
    if (idempotency.outcome !== 'miss') {
        return idempotency.outcome === 'replay'
            ? { ...idempotency, rejectionCode: null }
            : idempotency;
    }

    switch (command.operation) {
        case 'createGroup':
            return computeCreate(command, read, facts);
        case 'updateGroup':
            return computeUpdate(command, read, facts);
        case 'appointDirector':
            return computeDirector(command, read, facts);
        case 'startGroupEstablishment':
        case 'planGroupLayout':
        case 'connectGroup':
        case 'activateGroup':
        case 'reopenGroupEstablishment':
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
