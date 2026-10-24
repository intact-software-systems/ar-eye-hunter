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
import type { RuntimeStateEntryPageOptions } from '../../../runtime-state/runtime-state-repository.ts';
import { decodeAuthSessionBySessionIdEntry } from '../../auth/persistence/auth-session-persistence.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
import { assertGroupMutationIdempotencyRecord } from '../mutation/state-validation/assert-group-mutation-result.ts';
import {
    assertStoredIdempotency,
    canonicalStoredGroup,
    canonicalStoredGroupRecord
} from './aggregate/group-aggregate-repository.ts';
import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from './aggregate/group-aggregate-storage-keys.ts';
import { isRetiredGroupIdentity, type RetiredGroupIdentity } from './aggregate/retired-group-identity.ts';
import { toGroupLifecyclePolicyRead } from './group-lifecycle-policy-repository.ts';
import {
    decodeStoredGroupStateKey,
    decodeStoredGroupStateValue,
    toGroupStateReadBatchLiveSelections
} from './group-state-persistence-contracts.ts';
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
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSessionStorageKeySuffix
} from './presence/group-presence-storage-keys.ts';
import {
    readGroupStateMutationExactEntries,
    type GroupStateMutationExactEntries,
    type GroupStateMutationExactReadInput
} from './read-exact-group-state-mutation.ts';
import { readGroupRetirementEntries, type GroupRetirementEntry } from './read-group-retirement-entries.ts';
import { toGroupPresenceSummarySelectors } from './read-group-state-authority.ts';

/** A presence summary's stored rows, read as one consistent snapshot. */
export interface GroupPresenceSummaryStoredRead {
    readonly group: RuntimeStateEntryValue<Group> | undefined;
    readonly members: readonly RuntimeStateEntryValue<GroupMember>[];
    readonly admissions: readonly RuntimeStateEntryValue<GroupPresenceAdmission>[];
    readonly presenceSessions: readonly RuntimeStateEntryValue<GroupPresenceSession>[];
    readonly current: RuntimeStateEntryValue<GroupPresenceSummary> | undefined;
}

export namespace GroupStateRepositoryReads {
    export interface GroupRead extends RuntimeStateEntryRead<Group> {
        readonly retiredGroup: RetiredGroupIdentity | null;
    }

    export interface GroupPage {
        readonly groups: readonly Group[];
        readonly nextKey: string | null;
    }
}

export class GroupStateRepositoryReads extends GroupStateSnapshotRepository {
    async readMutationExactEntries(
        input: GroupStateMutationExactReadInput
    ): Promise<GroupStateMutationExactEntries> {
        const observedAtEpochMs = Date.now();
        return await readGroupStateMutationExactEntries(
            {
                repository: this.repository,
                input: input,
                observedAtEpochMs,
                decoders: {
                    group: (entry) => canonicalStoredGroupRecord(entry, input.aggregateRef),
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
                        }),
                    lifecyclePolicy: (value) => toGroupLifecyclePolicyRead(value, input.aggregateRef),
                    authSession: decodeAuthSessionBySessionIdEntry,
                    groupSnapshot: (rows) =>
                        this.toStableAuthoritativeSnapshot(input.aggregateRef, rows, observedAtEpochMs)?.snapshot
                }
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

    async findGroupEntry(ref: GroupRef): Promise<RuntimeStateEntryValue<Group> | undefined> {
        return (await this.readGroupEntry(ref)).value;
    }

    async readGroupEntry(ref: GroupRef): Promise<GroupStateRepositoryReads.GroupRead> {
        const stored = await this.getJsonEntryRead(
            GROUPS_NAMESPACE,
            groupStateGroupStorageKey(ref)
        );
        const record = stored.value ? canonicalStoredGroupRecord(stored.value, ref) : undefined;
        const retiredGroup = record && isRetiredGroupIdentity(record.value) ? record.value : null;
        return {
            value: record && !isRetiredGroupIdentity(record.value)
                ? { entry: record.entry, value: record.value }
                : undefined,
            expiredEntry: stored.expiredEntry,
            retiredGroup
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

    /** Cross-scope maintenance scans advance by physical key even when an expired row yields no live group. */
    async listGroupsPage(options: RuntimeStateEntryPageOptions): Promise<GroupStateRepositoryReads.GroupPage> {
        if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500) {
            throw new TypeError('Group maintenance page limit must be an integer from 1 through 500');
        }
        const entries = await this.repository.findEntriesByPrefixPage(GROUPS_NAMESPACE, '', options);
        const groups: Group[] = [];
        for (const entry of entries) {
            const stored = await this.toLiveJsonEntryValue(GROUPS_NAMESPACE, entry);
            if (stored !== undefined) {
                const ref = decodeStoredGroupStateKey(entry.key, decodeGroupStateGroupStorageKey);
                const group = canonicalStoredGroup(stored, ref);
                if (group !== undefined) {
                    groups.push(group.value);
                }
            }
        }
        return { groups, nextKey: entries.length === options.limit ? entries[entries.length - 1].key : null };
    }

    async listGroups(scope: GroupScope): Promise<readonly Group[]> {
        const stored = await this.listJsonEntryValues(
            GROUPS_NAMESPACE,
            `${groupStateScopeStorageKey(scope)}:`
        );
        return stored.flatMap((entry) => {
            const group = canonicalStoredGroup(entry, scope);
            return group === undefined ? [] : [group.value];
        });
    }

    async readRetirementEntries(ref: GroupRef): Promise<readonly GroupRetirementEntry[]> {
        return await readGroupRetirementEntries(this.repository, ref);
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

    async listPresenceSessions(ref: GroupRef): Promise<readonly GroupPresenceSession[]> {
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

    async listPresenceSessionsForSessionIds(
        sessionIds: readonly string[]
    ): Promise<readonly GroupPresenceSession[]> {
        if (sessionIds.length === 0) {
            return [];
        }
        const selections = await this.repository.readRuntimeStateBatch(
            [...new Set(sessionIds)].map((sessionId, index) => ({
                selectorId: `session:${index}`,
                kind: 'suffix',
                namespace: SESSIONS_NAMESPACE,
                keySuffix: groupStatePresenceSessionStorageKeySuffix(sessionId)
            }))
        );
        const sessions: GroupPresenceSession[] = [];
        for (const entry of selections.flatMap((selection) => selection.entries)) {
            const stored = await this.toLiveJsonEntryValue(SESSIONS_NAMESPACE, entry);
            if (stored !== undefined) {
                sessions.push(canonicalStoredSession(stored).value);
            }
        }
        return sessions;
    }

    async listAllPresenceSessions(): Promise<readonly GroupPresenceSession[]> {
        const stored = await this.listJsonEntryValues(SESSIONS_NAMESPACE);
        return stored.map((entry) => canonicalStoredSession(entry).value);
    }

    /**
     * The group, its members, admissions, sessions and current summary in one batch read, so the
     * rows come from one database snapshot rather than one statement each (D295).
     */
    async readPresenceSummaryEntries(ref: GroupRef): Promise<GroupPresenceSummaryStoredRead> {
        const observedAtEpochMs = Date.now();
        const selectors = toGroupPresenceSummarySelectors(ref);
        const [group, members, summary, sessions, admissions] = toGroupStateReadBatchLiveSelections(
            selectors,
            await this.repository.readRuntimeStateBatch(selectors),
            observedAtEpochMs
        );
        const storedGroup = group.entries[0];
        const storedSummary = summary.entries[0];
        return {
            group: storedGroup === undefined ? undefined : canonicalStoredGroup(storedGroup, ref),
            members: members.entries.map((entry) => canonicalStoredMember(entry, ref)),
            admissions: admissions.entries.map((entry) => canonicalStoredAdmission(entry, ref)),
            presenceSessions: sessions.entries.map((entry) => canonicalStoredSession(entry, ref)),
            current: storedSummary === undefined ? undefined : canonicalStoredSummary(storedSummary, ref)
        };
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
        {
            value: stored.value,
            ref: expected,
            storageKey: stored.entry.key,
            decode: decodeGroupMutationIdempotencyRecord,
            invalidValueMessage: 'Stored group idempotency value is invalid'
        }
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
