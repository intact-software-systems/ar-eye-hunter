import type {
    GroupMember,
    GroupRef,
} from '@shared/api/group-types.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryValue,
} from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import { normalizePersistedGroupMember } from './group-state-persistence-codec.ts';
import {
    assertGroupRefIdentity,
    assertTrustedGroupRef,
    decodeStoredGroupStateKey,
    normalizeStoredGroupStateValue,
    throwGroupStateIdentityCorruption,
} from './group-state-persistence-contracts.ts';
import {
    decodeGroupStateMemberStorageKey,
    groupStateMemberStorageKey,
} from './group-state-storage-keys.ts';
import { MEMBERS_NAMESPACE } from './group-state-runtime-namespaces.ts';
import { validatePersistedGroupMember } from './validate-persisted-group.ts';

export class GroupMembershipRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putMember(member: GroupMember): Promise<void> {
        validatePersistedGroupMember(member, member);
        await this.putValue(
            MEMBERS_NAMESPACE,
            groupStateMemberStorageKey(member),
            member,
        );
    }

    async removeMember(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<void> {
        await this.deleteValue(MEMBERS_NAMESPACE, groupStateMemberStorageKey(ref));
    }
}

export function canonicalStoredMember(
    stored: RuntimeStateEntryValue<unknown>,
    expected?: GroupRef & Readonly<{ principalId?: string }>,
): RuntimeStateEntryValue<GroupMember> {
    const decoded = decodeStoredGroupStateKey(
        stored.entry.key,
        decodeGroupStateMemberStorageKey,
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = normalizeStoredGroupStateValue(
        stored.value,
        decoded,
        stored.entry.key,
        normalizePersistedGroupMember,
        'Stored group member value is invalid',
    );
    assertGroupRefIdentity(value, decoded, stored.entry.key);
    if (
        value.principalId !== decoded.principalId ||
        (expected?.principalId !== undefined &&
            decoded.principalId !== expected.principalId)
    ) {
        throwGroupStateIdentityCorruption(stored.entry.key, 'member principal');
    }
    return { entry: stored.entry, value };
}
