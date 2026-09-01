import type { GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { groupStateMemberStorageKey } from '../../persistence/membership/group-membership-storage-key.ts';
import { validateGroupStateRuntimeEntry } from '../../persistence/validate-group-state-runtime-entry.ts';
import { validateStoredMember } from '../../persistence/validate-persisted-group.ts';
import type { GroupMutationRead } from '../group-mutation-contracts.ts';
import type { GroupMutationReadIdentities } from '../read/resolve-group-mutation-read-identities.ts';

export function assertGroupMutationMemberReads(
    read: GroupMutationRead,
    ref: GroupRef,
    identities: GroupMutationReadIdentities
): void {
    assertMemberReadPair({
        member: read.actorMember,
        stored: read.actorMemberEntry,
        ref,
        expectedPrincipalId: identities.actorPrincipalId,
        label: 'Actor member'
    });
    assertMemberReadPair({
        member: read.targetMember,
        stored: read.targetMemberEntry,
        ref,
        expectedPrincipalId: identities.targetPrincipalId,
        label: 'Target member'
    });
    assertMemberReadPair({
        member: read.authorityMember,
        stored: read.authorityMemberEntry,
        ref,
        expectedPrincipalId: identities.ownerPrincipalId,
        label: 'Authority member'
    });
    assertMemberReadPair({
        member: read.directorMember,
        stored: read.directorMemberEntry,
        ref,
        expectedPrincipalId: identities.directorPrincipalId,
        label: 'Director member'
    });
}

interface AssertMemberReadPairInput {
    readonly member: GroupMember | null;
    readonly stored: RuntimeStateEntryValue<GroupMember> | null;
    readonly ref: GroupRef;
    readonly expectedPrincipalId: string | null;
    readonly label: string;
}

function assertMemberReadPair({
    member,
    stored,
    ref,
    expectedPrincipalId,
    label
}: AssertMemberReadPairInput): void {
    if ((member === null) !== (stored === null)) {
        throw new TypeError(`${label} differs from stored entry presence`);
    }
    if (!member || !stored) {
        return;
    }
    if (expectedPrincipalId === null || member.principalId !== expectedPrincipalId) {
        throw new TypeError(`${label} principal differs from command slot identity`);
    }
    validateGroupStateRuntimeEntry(
        stored,
        `Stored ${label.toLowerCase()}`,
        groupStateMemberStorageKey({ ...ref, principalId: expectedPrincipalId })
    );
    validateStoredMember(stored.value, ref, label);
    if (!jsonEquals(member, stored.value)) {
        throw new TypeError(`${label} differs from stored entry value`);
    }
}
