import { computeGroupSessionMutation } from '../../schedule/compute-group-session-mutation.ts';
import { computeApplyPlannedLayout } from '../aggregate/compute-apply-planned-layout.ts';
import {
    computeDirector,
    computeRotateJoinCode,
    computeUpdate
} from '../aggregate/compute-group-aggregate-mutation.ts';
import { computeGroupTransportMutation } from '../aggregate/compute-group-transport-mutation.ts';
import { computeLifecycleTransition } from '../aggregate/compute-lifecycle-transition.ts';
import { computeUpdateGroupActivationStatus } from '../aggregate/compute-update-group-activation-status.ts';
import { computeCreate } from '../aggregate/create-initial-group-mutation.ts';
import { assertGroupMutationAuthority } from '../command-validation/assert-group-mutation-authority.ts';
import { assertGroupMutationCommand } from '../command-validation/assert-group-mutation-command.ts';
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
import { computeGroupPublicationGrantMutation } from '../publication/compute-group-publication-grant-mutation.ts';
import { assertGroupMutationFacts } from '../state-validation/assert-group-mutation-facts.ts';
import { assertGroupMutationRead } from '../state-validation/assert-group-mutation-read.ts';

export interface GroupMutationInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
}

export function computeGroupMutation(input: GroupMutationInput): GroupMutationComputed {
    const { command, read, facts } = input;
    assertGroupMutationCommand(command);
    assertGroupMutationRead(read, command);
    assertGroupMutationFacts(facts);
    assertGroupMutationAuthority(command, facts);
    if (read.idempotency !== null) {
        const record = read.idempotency.value;
        if (record.receipt.commandId !== command.commandId) {
            throw new TypeError('Stored group idempotency receipt command differs from command identity');
        }
        return record.commandHash === facts.commandHash
            ? { outcome: 'replay', rejectionCode: null, receipt: record.receipt }
            : {
                outcome: 'idempotency-conflict',
                existingCommandHash: record.commandHash,
                receivedCommandHash: facts.commandHash
            };
    }
    if (command.operation !== 'createGroup' && read.group === null) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Group not found: ${command.aggregateRef.groupId}`
        });
    }

    return computeFreshGroupMutation(command, read, facts);
}

function computeFreshGroupMutation(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    switch (command.operation) {
        case 'changeGroupSession':
            return computeGroupSessionMutation(command, read, facts);
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
        case 'updateGroupActivationStatus':
            return computeUpdateGroupActivationStatus(command, read, facts);
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
        case 'grantGroupPublication':
        case 'revokeGroupPublication':
            return computeGroupPublicationGrantMutation(command, read, facts);
        case 'transferGroupOwnership':
            return computeTransfer(command, read, facts);
        case 'upsertMember':
            return computeUpsertMember(command, read, facts);
        case 'connectPresence':
        case 'heartbeatPresence':
        case 'disconnectPresence':
            return computePresenceMutation(command, read, facts);
    }
}

function computePresenceMutation(
    command: Extract<
        GroupMutationCommand,
        { operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence'; }
    >,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    switch (command.operation) {
        case 'connectPresence':
            return computeConnectGroupPresence(command, read, facts);
        case 'heartbeatPresence':
            return computeHeartbeatGroupPresence(command, read, facts);
        case 'disconnectPresence':
            return computeDisconnectGroupPresence(command, read, facts);
    }
}
