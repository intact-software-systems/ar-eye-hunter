import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';

import {
    validateExactKeys,
    validateNonNegativeSafeInteger,
    validateOneOf,
    validateRequiredKeys
} from '../../group-state-validation-issues.ts';
import {
    validatePresenceAdmission,
    validatePresenceSummaryValue
} from '../../persistence/validate-persisted-group-presence.ts';
import { validateStoredMember } from '../../persistence/validate-persisted-group.ts';
import { validateInitialGroupPresenceSummaryCandidate } from '../../presence/group-initial-presence-summary.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import { resolveGroupMutationTargetPrincipalId } from '../orchestration/resolve-group-mutation-target-identity.ts';
import type { ValidateComputedGroupMutationWriteInput } from './validate-computed-group-mutation-write.ts';

export function validateComputedGroupMutationMembers(
    input: ValidateComputedGroupMutationWriteInput
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateComputedMembers(input));
    issues.push(...validateComputedInitialPresenceSummary(input));
    issues.push(...validateComputedPresenceAdmission(input));
    return issues;
}

function validateComputedMembers({
    command,
    read,
    computed
}: ValidateComputedGroupMutationWriteInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!Array.isArray(computed.members)) {
        return [toGroupStateValidationIssue('computed.members', 'Group mutation computed members must be an array')];
    }
    for (const member of computed.members) {
        issues.push(...validateStoredMember(member, command.aggregateRef, 'Group mutation computed member'));
    }
    const expected = expectedMutationMemberPrincipalIds(command, read);
    const actual = computed.members.map((member) => isGroupStateRecord(member) ? member.principalId : undefined)
        .toSorted();
    if (!jsonEquals(actual, expected)) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.members',
                'Group mutation member candidate identity differs from command target'
            )
        );
    }
    return issues;
}

function validateComputedInitialPresenceSummary({
    command,
    read,
    computed
}: ValidateComputedGroupMutationWriteInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (computed.initialPresenceSummary === null) {
        return issues;
    }
    if (command.operation !== 'createGroup') {
        issues.push(
            toGroupStateValidationIssue(
                'computed.initialPresenceSummary',
                'Initial group presence summary operation requires group creation'
            )
        );
    }
    issues.push(...validateInitialGroupPresenceSummaryCandidate(
        computed.initialPresenceSummary,
        read.presenceSummary
    ));
    if (isGroupStateRecord(computed.initialPresenceSummary)) {
        issues.push(...validatePresenceSummaryValue(computed.initialPresenceSummary.value, command.aggregateRef));
    }
    return issues;
}

function validateComputedPresenceAdmission({
    command,
    read,
    computed
}: ValidateComputedGroupMutationWriteInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (computed.presenceAdmission === null) {
        return issues;
    }
    const admission = computed.presenceAdmission;
    if (!isGroupStateRecord(admission)) {
        return [
            toGroupStateValidationIssue(
                'computed.presenceAdmission',
                'Group mutation computed admission must be an object'
            )
        ];
    }
    const expectedKeys = [
        'operation',
        'value',
        ...(admission.operation === 'update' ? ['expectedRevision'] : [])
    ];
    issues.push(...validateExactKeys(admission, expectedKeys, 'Group mutation computed admission'));
    issues.push(...validateRequiredKeys(admission, expectedKeys, 'Group mutation computed admission'));
    issues.push(...validateOneOf(
        admission.operation,
        ['insert', 'update'],
        'Group mutation computed admission operation'
    ));
    issues.push(...validatePresenceAdmission(admission.value, command.aggregateRef));
    issues.push(...validateComputedAdmissionPredecessor(read, admission));
    const admittedPrincipalId = isGroupStateRecord(admission.value) ? admission.value.principalId : undefined;
    const expectedPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    if (expectedPrincipalId === null || expectedPrincipalId !== admittedPrincipalId) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.presenceAdmission',
                'Group mutation admission principal differs from command target identity'
            )
        );
    }
    return issues;
}

function validateComputedAdmissionPredecessor(
    read: GroupMutationRead,
    admission: NonNullable<ValidateComputedGroupMutationWriteInput['computed']['presenceAdmission']>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (admission.operation === 'update') {
        issues.push(...validateNonNegativeSafeInteger(
            admission.expectedRevision,
            'Group mutation computed admission expectedRevision'
        ));
    }
    const predecessor = read.targetAdmission;
    if (admission.operation === 'insert') {
        if (predecessor !== null) {
            issues.push(
                toGroupStateValidationIssue(
                    'computed.presenceAdmission.expectedRevision',
                    'Group mutation admission insert has an existing predecessor'
                )
            );
        }
    }
    else if (predecessor === null || admission.expectedRevision !== predecessor.entry.revision) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.presenceAdmission.expectedRevision',
                'Group mutation admission update revision differs from predecessor'
            )
        );
    }
    return issues;
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

