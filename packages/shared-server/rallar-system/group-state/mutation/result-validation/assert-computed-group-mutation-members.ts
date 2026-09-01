import { jsonEquals } from '@shared/repository/state-utils.ts';

import {
    assertExactKeys,
    assertRequiredKeys,
    requireNonNegativeSafeInteger,
    requireOneOf
} from '../../group-state-validation-primitives.ts';
import {
    validatePresenceAdmission,
    validatePresenceSummaryValue
} from '../../persistence/validate-persisted-group-presence.ts';
import { validateStoredMember } from '../../persistence/validate-persisted-group.ts';
import { validateInitialGroupPresenceSummaryCandidate } from '../../presence/group-initial-presence-summary.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import { resolveGroupMutationTargetPrincipalId } from '../orchestration/resolve-group-mutation-target-identity.ts';
import type { AssertComputedGroupMutationWriteInput } from './assert-computed-group-mutation-write.ts';

export function assertComputedGroupMutationMembers(
    input: AssertComputedGroupMutationWriteInput
): void {
    assertComputedMembers(input);
    assertComputedInitialPresenceSummary(input);
    assertComputedPresenceAdmission(input);
}

function assertComputedMembers({
    command,
    read,
    computed
}: AssertComputedGroupMutationWriteInput): void {
    if (!Array.isArray(computed.members)) {
        throw new TypeError('Group mutation computed members must be an array');
    }
    for (const member of computed.members) {
        validateStoredMember(member, command.aggregateRef, 'Group mutation computed member');
    }
    const expected = expectedMutationMemberPrincipalIds(command, read);
    const actual = computed.members.map((member) => member.principalId).toSorted();
    if (!jsonEquals(actual, expected)) {
        throw new TypeError('Group mutation member candidate identity differs from command target');
    }
}

function assertComputedInitialPresenceSummary({
    command,
    read,
    computed
}: AssertComputedGroupMutationWriteInput): void {
    if (computed.initialPresenceSummary === null) {
        return;
    }
    if (command.operation !== 'createGroup') {
        throw new TypeError('Initial group presence summary operation requires group creation');
    }
    validateInitialGroupPresenceSummaryCandidate(
        computed.initialPresenceSummary,
        read.presenceSummary
    );
    validatePresenceSummaryValue(computed.initialPresenceSummary.value, command.aggregateRef);
}

function assertComputedPresenceAdmission({
    command,
    read,
    computed
}: AssertComputedGroupMutationWriteInput): void {
    if (computed.presenceAdmission === null) {
        return;
    }
    const admission = computed.presenceAdmission;
    const expectedKeys = [
        'operation',
        'value',
        ...(admission.operation === 'update' ? ['expectedRevision'] : [])
    ];
    assertExactKeys(admission, expectedKeys, 'Group mutation computed admission');
    assertRequiredKeys(admission, expectedKeys, 'Group mutation computed admission');
    requireOneOf(
        admission.operation,
        ['insert', 'update'],
        'Group mutation computed admission operation'
    );
    validatePresenceAdmission(admission.value, command.aggregateRef);
    assertComputedAdmissionPredecessor(read, admission);
    const admittedPrincipalId = admission.value.principalId;
    const expectedPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    if (expectedPrincipalId === null || expectedPrincipalId !== admittedPrincipalId) {
        throw new TypeError('Group mutation admission principal differs from command target identity');
    }
}

function assertComputedAdmissionPredecessor(
    read: GroupMutationRead,
    admission: NonNullable<AssertComputedGroupMutationWriteInput['computed']['presenceAdmission']>
): void {
    if (admission.operation === 'update') {
        requireNonNegativeSafeInteger(
            admission.expectedRevision,
            'Group mutation computed admission expectedRevision'
        );
    }
    const predecessor = read.targetAdmission;
    if (admission.operation === 'insert') {
        if (predecessor !== null) {
            throw new TypeError('Group mutation admission insert has an existing predecessor');
        }
    }
    else if (predecessor === null || admission.expectedRevision !== predecessor.entry.revision) {
        throw new TypeError('Group mutation admission update revision differs from predecessor');
    }
}

function expectedMutationMemberPrincipalIds(
    command: GroupMutationCommand,
    read: GroupMutationRead
): readonly string[] {
    switch (command.operation) {
        case 'createGroup':
            return [command.input.createdByPrincipalId];
        case 'joinGroup':
        case 'acceptGroupInvite':
        case 'createGroupInvite':
        case 'revokeGroupInvite':
        case 'grantGroupAdmission':
        case 'declineGroupAdmission':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'setGroupMemberRole':
        case 'upsertMember':
            return [command.targetPrincipalId];
        case 'transferGroupOwnership': {
            const currentOwner = read.group?.value.ownerPrincipalId;
            return currentOwner === undefined
                ? [command.targetPrincipalId]
                : [currentOwner, command.targetPrincipalId].toSorted();
        }
        default:
            return [];
    }
}
