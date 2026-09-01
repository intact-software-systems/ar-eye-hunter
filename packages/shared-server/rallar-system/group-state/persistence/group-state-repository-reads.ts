import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupScope,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';

import type { RuntimeStateEntryRead, RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
import { assertGroupMutationIdempotencyRecord } from '../mutation/result-validation/assert-group-mutation-result.ts';
import { assertStoredIdempotency, canonicalStoredGroup } from './aggregate/group-aggregate-repository.ts';
import { groupStateGroupStorageKey, groupStateScopeStorageKey } from './aggregate/group-aggregate-storage-keys.ts';
import { decodeStoredGroupStateValue } from './group-state-persistence-contracts.ts';
import {
    GROUPS_NAMESPACE,
    IDEMPOTENT_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';
import { GroupStateSnapshotRepository } from './group-state-snapshot-repository.ts';
import { groupStateIdempotencyStorageKey } from './idempotency/group-idempotency-storage-key.ts';
import { canonicalStoredMember } from './membership/group-membership-repository.ts';
import { groupStateMemberStorageKey } from './membership/group-membership-storage-key.ts';
import {
    canonicalStoredAdmission,
    canonicalStoredSession,
    canonicalStoredSummary
} from './presence/group-presence-repository.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from './presence/group-presence-storage-keys.ts';
import {
    readGroupStateMutationExactEntries,
    type GroupStateMutationExactReadInput,
    type GroupStateMutationExactReadResult
} from './read-exact-group-state-mutation.ts';

export class GroupStateRepositoryReads extends GroupStateSnapshotRepository {
    async readMutationExactEntries(
        input: GroupStateMutationExactReadInput
    ): Promise<GroupStateMutationExactReadResult> {
        return await readGroupStateMutationExactEntries(
            this.repository,
            input,
            async (namespace, entry) => await this.toLiveJsonEntryValue(namespace, entry),
            {
                group: (entry) => canonicalStoredGroup(entry, input.aggregateRef),
                presenceSummary: (entry) => canonicalStoredSummary(entry, input.aggregateRef),
                idempotency: (requestId, entry) =>
                    canonicalStoredIdempotency(entry, {
                        ...input.aggregateRef,
                        requestId
                    }),
                member: (principalId, entry) =>
                    canonicalStoredMember(entry, {
                        ...input.aggregateRef,
                        principalId
                    }),
                presenceSession: (sessionId, entry) =>
                    canonicalStoredSession(entry, {
                        ...input.aggregateRef,
                        sessionId
                    }),
                admission: (principalId, entry) =>
                    canonicalStoredAdmission(entry, {
                        ...input.aggregateRef,
                        principalId
                    })
            }
        );
    }

    async findIdempotentGroupMutationReceipt(
        ref: GroupRef,
        requestId: string
    ): Promise<GroupMutationIdempotencyRecord | undefined> {
        return (await this.findIdempotentGroupMutationReceiptEntry(ref, requestId))?.value;
    }

    async findIdempotentGroupMutationReceiptEntry(
        ref: GroupRef,
        requestId: string
    ): Promise<RuntimeStateEntryValue<GroupMutationIdempotencyRecord> | undefined> {
        const stored = await this.getJsonEntryValue(
            IDEMPOTENT_NAMESPACE,
            groupStateIdempotencyStorageKey(ref, requestId)
        );
        return stored
            ? canonicalStoredIdempotency(stored, { ...ref, requestId })
            : undefined;
    }

    override async findGroupEntry(ref: GroupRef): Promise<RuntimeStateEntryValue<Group> | undefined> {
        return (await this.readGroupEntry(ref)).value;
    }

    async readGroupEntry(ref: GroupRef): Promise<RuntimeStateEntryRead<Group>> {
        const stored = await this.getJsonEntryRead(
            GROUPS_NAMESPACE,
            groupStateGroupStorageKey(ref)
        );
        return {
            value: stored.value ? canonicalStoredGroup(stored.value, ref) : undefined,
            expiredEntry: stored.expiredEntry
        };
    }

    async findGroup(ref: GroupRef): Promise<Group | undefined> {
        return (await this.findGroupEntry(ref))?.value;
    }

    async readCausalRevision(
        ref: GroupRef
    ): Promise<GroupStateCausalRevision | undefined> {
        const [stored, summary] = await Promise.all([
            this.findGroupEntry(ref),
            this.findPresenceSummaryEntry(ref)
        ]);
        return stored
            ? {
                groupRevision: stored.value.snapshotVersion,
                presenceRevision: summary?.value.causalRevision.presenceRevision ?? 0
            }
            : undefined;
    }

    async listGroups(scope: GroupScope): Promise<readonly Group[]> {
        const stored = await this.listJsonEntryValues(
            GROUPS_NAMESPACE,
            `${groupStateScopeStorageKey(scope)}:`
        );
        return stored.map((entry) => canonicalStoredGroup(entry, scope).value);
    }

    async findGroupBySlug(scope: GroupScope, slug: string): Promise<Group | undefined> {
        return (await this.listGroups(scope)).find((group) => group.slug === slug);
    }

    async findMember(
        ref: GroupRef & Readonly<{ principalId: string; }>
    ): Promise<GroupMember | undefined> {
        return (await this.findMemberEntry(ref))?.value;
    }

    async findMemberEntry(
        ref: GroupRef & Readonly<{ principalId: string; }>
    ): Promise<RuntimeStateEntryValue<GroupMember> | undefined> {
        const stored = await this.getJsonEntryValue(
            MEMBERS_NAMESPACE,
            groupStateMemberStorageKey(ref)
        );
        return stored ? canonicalStoredMember(stored, ref) : undefined;
    }

    override async listMembers(ref: GroupRef): Promise<readonly GroupMember[]> {
        return (await this.listMemberEntries(ref)).map(({ value }) => value);
    }

    async listMemberEntries(ref: GroupRef): Promise<readonly RuntimeStateEntryValue<GroupMember>[]> {
        const stored = await this.listJsonEntryValues(
            MEMBERS_NAMESPACE,
            `${groupStateGroupStorageKey(ref)}:`
        );
        return stored.map((entry) => canonicalStoredMember(entry, ref));
    }

    async findPresenceEntry(
        ref: GroupRef & Readonly<{ sessionId: string; }>
    ): Promise<RuntimeStateEntryValue<GroupPresenceSession> | undefined> {
        return (await this.readPresenceEntry(ref)).value;
    }

    async readPresenceEntry(
        ref: GroupRef & Readonly<{ sessionId: string; }>
    ): Promise<RuntimeStateEntryRead<GroupPresenceSession>> {
        const stored = await this.getJsonEntryRead(
            SESSIONS_NAMESPACE,
            groupStatePresenceSessionStorageKey(ref)
        );
        return {
            value: stored.value ? canonicalStoredSession(stored.value, ref) : undefined,
            expiredEntry: stored.expiredEntry
        };
    }

    async findPresenceSession(
        ref: GroupRef & Readonly<{ sessionId: string; }>
    ): Promise<GroupPresenceSession | undefined> {
        return (await this.findPresenceEntry(ref))?.value;
    }

    override async listPresenceSessions(ref: GroupRef): Promise<readonly GroupPresenceSession[]> {
        return (await this.listPresenceSessionEntries(ref)).map(({ value }) => value);
    }

    async listPresenceSessionEntries(
        ref: GroupRef
    ): Promise<readonly RuntimeStateEntryValue<GroupPresenceSession>[]> {
        const stored = await this.listJsonEntryValues(
            SESSIONS_NAMESPACE,
            `${groupStateGroupStorageKey(ref)}:`
        );
        return stored.map((entry) => canonicalStoredSession(entry, ref));
    }

    async findPresenceAdmissionEntry(
        ref: GroupRef & Readonly<{ principalId: string; }>
    ): Promise<RuntimeStateEntryValue<GroupPresenceAdmission> | undefined> {
        const stored = await this.getJsonEntryValue(
            PRESENCE_ADMISSIONS_NAMESPACE,
            groupStatePresenceAdmissionStorageKey(ref)
        );
        return stored ? canonicalStoredAdmission(stored, ref) : undefined;
    }

    async listPresenceAdmissions(ref: GroupRef): Promise<readonly GroupPresenceAdmission[]> {
        return (await this.listPresenceAdmissionEntries(ref)).map(({ value }) => value);
    }

    async listPresenceAdmissionEntries(
        ref: GroupRef
    ): Promise<readonly RuntimeStateEntryValue<GroupPresenceAdmission>[]> {
        const stored = await this.listJsonEntryValues(
            PRESENCE_ADMISSIONS_NAMESPACE,
            `${groupStateGroupStorageKey(ref)}:`
        );
        return stored.map((entry) => canonicalStoredAdmission(entry, ref));
    }

    async listAllPresenceSessions(): Promise<readonly GroupPresenceSession[]> {
        const stored = await this.listJsonEntryValues(SESSIONS_NAMESPACE);
        return stored.map((entry) => canonicalStoredSession(entry).value);
    }

    override async findPresenceSummaryEntry(
        ref: GroupRef
    ): Promise<RuntimeStateEntryValue<GroupPresenceSummary> | undefined> {
        const stored = await this.getJsonEntryValue(
            PRESENCE_SUMMARIES_NAMESPACE,
            groupStateGroupStorageKey(ref)
        );
        return stored ? canonicalStoredSummary(stored, ref) : undefined;
    }
}

function canonicalStoredIdempotency(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected: GroupRef & Readonly<{ requestId: string; }>
): RuntimeStateEntryValue<GroupMutationIdempotencyRecord> {
    const value = decodeStoredGroupStateValue(
        stored.value,
        expected,
        stored.entry.key,
        decodeGroupMutationIdempotencyRecord,
        'Stored group idempotency value is invalid'
    );
    const decoded = { entry: stored.entry, value };
    assertStoredIdempotency(decoded, expected);
    return decoded;
}

function decodeGroupMutationIdempotencyRecord(
    value: JsonWireValue,
    expected: GroupRef
): GroupMutationIdempotencyRecord {
    assertGroupMutationIdempotencyRecord(value, expected);
    return value;
}
