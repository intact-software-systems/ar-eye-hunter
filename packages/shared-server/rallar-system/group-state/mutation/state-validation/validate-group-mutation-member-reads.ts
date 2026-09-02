import type { GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { groupStateMemberStorageKey } from '../../persistence/membership/group-membership-storage-key.ts';
import { validateGroupStateRuntimeEntry } from '../../persistence/validate-group-state-runtime-entry.ts';
import { validateStoredMember } from '../../persistence/validate-persisted-group.ts';
import type { GroupMutationRead } from '../group-mutation-contracts.ts';
import type { GroupMutationReadIdentities } from '../read/resolve-group-mutation-read-identities.ts';

export function validateGroupMutationMemberReads(
    read: GroupMutationRead,
    ref: GroupRef,
    identities: GroupMutationReadIdentities
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateMemberReadPair({
        member: read.actorMember,
        stored: read.actorMemberEntry,
        ref,
        expectedPrincipalId: identities.actorPrincipalId,
        label: 'Actor member'
    }));
    issues.push(...validateMemberReadPair({
        member: read.targetMember,
        stored: read.targetMemberEntry,
        ref,
        expectedPrincipalId: identities.targetPrincipalId,
        label: 'Target member'
    }));
    issues.push(...validateMemberReadPair({
        member: read.authorityMember,
        stored: read.authorityMemberEntry,
        ref,
        expectedPrincipalId: identities.ownerPrincipalId,
        label: 'Authority member'
    }));
    issues.push(...validateMemberReadPair({
        member: read.directorMember,
        stored: read.directorMemberEntry,
        ref,
        expectedPrincipalId: identities.directorPrincipalId,
        label: 'Director member'
    }));
    return issues;
}

interface ValidateMemberReadPairInput {
    readonly member: GroupMember | null;
    readonly stored: RuntimeStateEntryValue<GroupMember> | null;
    readonly ref: GroupRef;
    readonly expectedPrincipalId: string | null;
    readonly label: string;
}

function validateMemberReadPair({
    member,
    stored,
    ref,
    expectedPrincipalId,
    label
}: ValidateMemberReadPairInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if ((member === null) !== (stored === null)) {
        issues.push(
            toGroupStateValidationIssue('read.member', `${label} differs from stored entry presence`)
        );
    }
    if (!member || !stored) {
        return issues;
    }
    if (expectedPrincipalId === null || member.principalId !== expectedPrincipalId) {
        issues.push(
            toGroupStateValidationIssue(
                'read.member',
                `${label} principal differs from command slot identity`
            )
        );
    }
    issues.push(...validateGroupStateRuntimeEntry(
        stored,
        `Stored ${label.toLowerCase()}`,
        expectedPrincipalId === null
            ? undefined
            : groupStateMemberStorageKey({ ...ref, principalId: expectedPrincipalId })
    ));
    issues.push(...validateStoredMember(stored.value, ref, label));
    if (!jsonEquals(member, stored.value)) {
        issues.push(toGroupStateValidationIssue('read.member', `${label} differs from stored entry value`));
    }
    return issues;
}

