import type { GroupMember, GroupRef } from '@shared/api/group-types.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryValue
} from '../../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { decodePersistedGroupMember } from '../group-state-persistence-codec.ts';
import {
    assertGroupRefIdentity,
    assertTrustedGroupRef,
    decodeStoredGroupStateKey,
    decodeStoredGroupStateValue,
    throwGroupStateIdentityCorruption
} from '../group-state-persistence-contracts.ts';
import { MEMBERS_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import { validateStoredMember } from '../validate-persisted-group.ts';
import { decodeGroupStateMemberStorageKey, groupStateMemberStorageKey } from './group-membership-storage-key.ts';

export class GroupMembershipRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putMember(member: GroupMember): Promise<void> {
        const persistedGroupMemberIssues = validateStoredMember(member, member, 'Stored group member');
        if (persistedGroupMemberIssues.length > 0) {
            throw persistedGroupMemberIssues[0].cause;
        }
        await this.putValue(MEMBERS_NAMESPACE, groupStateMemberStorageKey(member), member);
    }

    async removeMember(ref: GroupRef & Readonly<{ principalId: string; }>): Promise<void> {
        await this.deleteValue(MEMBERS_NAMESPACE, groupStateMemberStorageKey(ref));
    }
}

export function canonicalStoredMember(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected?: GroupRef & Readonly<{ principalId?: string; }>
): RuntimeStateEntryValue<GroupMember> {
    const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateMemberStorageKey);
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    const value = decodeStoredGroupStateValue(
        stored.value,
        decoded,
        stored.entry.key,
        decodePersistedGroupMember,
        'Stored group member value is invalid'
    );
    assertGroupRefIdentity(value, decoded, stored.entry.key);
    if (
        value.principalId !== decoded.principalId ||
        (expected?.principalId !== undefined && decoded.principalId !== expected.principalId)
    ) {
        throwGroupStateIdentityCorruption(stored.entry.key, 'member principal');
    }
    return { entry: stored.entry, value };
}
