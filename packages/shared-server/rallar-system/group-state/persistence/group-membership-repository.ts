import type {
    GroupMember,
    GroupRef,
} from '@shared/api/group-types.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryValue,
} from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import { normalizePersistedGroupMember } from './group-state-persistence-codec.ts';
import {
    assertGroupRefIdentity,
    assertTrustedGroupRef,
    decodeStoredGroupStateKey,
    normalizeStoredGroupStateValue,
    throwGroupStateIdentityCorruption,
    toLiveGroupStateEntryValue,
} from './group-state-persistence-contracts.ts';
import {
    decodeGroupStateMemberStorageKey,
    groupStateGroupStorageKey,
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

    async findMemberEntry(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<RuntimeStateEntryValue<GroupMember> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            MEMBERS_NAMESPACE,
            groupStateMemberStorageKey(ref),
        );
        return stored ? canonicalStoredMember(stored, ref) : undefined;
    }

    async listMemberEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupMember>[]> {
        const stored = await this.listEntryValues<unknown>(
            MEMBERS_NAMESPACE,
            `${groupStateGroupStorageKey(ref)}:`,
        );
        return stored.map((entry) => canonicalStoredMember(entry, ref));
    }

    async removeMember(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<void> {
        await this.deleteValue(MEMBERS_NAMESPACE, groupStateMemberStorageKey(ref));
    }

    protected override async toLiveEntryValue<T>(
        _namespace: string,
        entry: RuntimeStateEntry,
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        return await toLiveGroupStateEntryValue<T>(entry);
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
