import type {
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupScope,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { RuntimeStateJsonStore, type RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/RuntimeStateRepository.ts';
import { readStableStateSnapshot } from '../../repositories/state-snapshot-read.ts';
import type { GroupSnapshotPage, GroupSnapshotPageOptions } from '../group-state-service-contracts.ts';
import {
    assembleGroupStateSnapshot,
    collectGroupStateValuesByGroupId,
    type GroupStateScopeSnapshotRead,
    type GroupStateSnapshotAssemblyInput,
    type GroupStateSnapshotPageGroup,
    type GroupStateSnapshotPageScan
} from './assemble-group-state-snapshot.ts';
import { canonicalStoredGroup, toGroupStateAuthorityGuard } from './group-aggregate-repository.ts';
import { canonicalStoredMember } from './group-membership-repository.ts';
import { canonicalStoredSession, canonicalStoredSummary } from './group-presence-repository.ts';
import {
    assertDecodedGroupScope,
    decodeStoredGroupStateKey,
    GroupStateRepositoryInvariantCorruptionError,
    toLiveGroupStateEntryValue,
    type GroupStateAuthoritativeSnapshot
} from './group-state-persistence-contracts.ts';
import {
    GROUPS_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';
import {
    decodeGroupStateGroupStorageKey,
    decodeGroupStateMemberStorageKey,
    decodeGroupStatePresenceSessionStorageKey,
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from './group-state-storage-keys.ts';
import { readGroupStateAuthorityBatch } from './read-group-state-authority.ts';

export abstract class GroupStateSnapshotRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    protected abstract findGroupEntry(
        ref: GroupRef
    ): Promise<RuntimeStateEntryValue<Group> | undefined>;

    protected abstract listMembers(ref: GroupRef): Promise<readonly GroupMember[]>;

    protected abstract findPresenceSummaryEntry(
        ref: GroupRef
    ): Promise<RuntimeStateEntryValue<GroupPresenceSummary> | undefined>;

    protected abstract listPresenceSessions(ref: GroupRef): Promise<readonly GroupPresenceSession[]>;

    async listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]> {
        const observedAtEpochMs = Date.now();
        const read = await this.readScopeSnapshot(scope);
        const beforeByKey = new Map(read.groupsBefore.map((stored) => [stored.entry.key, stored]));
        const snapshots = await Promise.all(
            read.groupsAfter.map(async (stored) => {
                const before = beforeByKey.get(stored.entry.key);
                if (!before || before.entry.revision !== stored.entry.revision) {
                    return await this.readSnapshot(stored.value);
                }
                return this.toSnapshot({
                    group: stored.value,
                    members: read.membersByGroupId.get(stored.value.groupId) ?? [],
                    summary: read.summariesByGroupId.get(stored.value.groupId),
                    authoritativeSessions: read.sessionsByGroupId.get(stored.value.groupId) ?? [],
                    groupRevision: stored.value.snapshotVersion,
                    observedAtEpochMs,
                    sessionLeaseFields: 'authoritative'
                });
            })
        );
        return snapshots.filter((snapshot): snapshot is GroupSnapshot => snapshot !== undefined);
    }

    private async readScopeSnapshot(scope: GroupScope): Promise<GroupStateScopeSnapshotRead> {
        const keyPrefix = `${groupStateScopeStorageKey(scope)}:`;
        const groupsBeforeRaw = await this.listEntryValues<unknown>(GROUPS_NAMESPACE, keyPrefix);
        const [memberEntriesRaw, summaryEntriesRaw, sessionEntriesRaw] = await Promise.all([
            this.listEntryValues<unknown>(MEMBERS_NAMESPACE, keyPrefix),
            this.listEntryValues<unknown>(PRESENCE_SUMMARIES_NAMESPACE, keyPrefix),
            this.listEntryValues<unknown>(SESSIONS_NAMESPACE, keyPrefix)
        ]);
        const groupsAfterRaw = await this.listEntryValues<unknown>(GROUPS_NAMESPACE, keyPrefix);
        const groupsBefore = groupsBeforeRaw.map((stored) => canonicalStoredGroup(stored, scope));
        const groupsAfter = groupsAfterRaw.map((stored) => canonicalStoredGroup(stored, scope));
        const members = memberEntriesRaw.map((stored) => {
            assertDecodedGroupScope(
                decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateMemberStorageKey),
                scope,
                stored.entry.key
            );
            return canonicalStoredMember(stored).value;
        });
        const summaries = summaryEntriesRaw.map((stored) => {
            const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateGroupStorageKey);
            assertDecodedGroupScope(decoded, scope, stored.entry.key);
            return canonicalStoredSummary(stored, decoded).value;
        });
        const sessions = sessionEntriesRaw.map((stored) => {
            const decoded = decodeStoredGroupStateKey(
                stored.entry.key,
                decodeGroupStatePresenceSessionStorageKey
            );
            assertDecodedGroupScope(decoded, scope, stored.entry.key);
            return canonicalStoredSession(stored).value;
        });
        return {
            groupsBefore,
            groupsAfter,
            membersByGroupId: collectGroupStateValuesByGroupId(members),
            summariesByGroupId: new Map(summaries.map((summary) => [summary.groupId, summary])),
            sessionsByGroupId: collectGroupStateValuesByGroupId(sessions)
        };
    }

    async listSnapshotsPage(
        scope: GroupScope,
        options: GroupSnapshotPageOptions
    ): Promise<GroupSnapshotPage> {
        const observedAtEpochMs = Date.now();
        const page = await this.readSnapshotPageGroups(scope, options);
        const pageGroups = page.groups;
        const candidates = await Promise.all(
            pageGroups.map(async ({ entry, group }) => {
                const [members, summary, sessions] = await Promise.all([
                    this.listMembers(group),
                    this.findPresenceSummaryEntry(group),
                    this.listPresenceSessions(group)
                ]);
                return { entry, group, members, summary: summary?.value, sessions };
            })
        );
        const groupsAfterRaw = await this.listEntryValuesByKeys<unknown>(
            GROUPS_NAMESPACE,
            pageGroups.map(({ entry }) => entry.key)
        );
        const groupsAfter = groupsAfterRaw.map((stored) => canonicalStoredGroup(stored, scope));
        const afterByKey = new Map(groupsAfter.map((stored) => [stored.entry.key, stored]));
        const resolved = await Promise.all(
            candidates.map(async (candidate) => {
                const after = afterByKey.get(candidate.entry.key);
                if (!after) {
                    return undefined;
                }
                if (after.entry.revision !== candidate.entry.revision) {
                    return await this.readSnapshot(after.value);
                }
                return this.toSnapshot({
                    group: after.value,
                    members: candidate.members,
                    summary: candidate.summary,
                    authoritativeSessions: candidate.sessions,
                    groupRevision: after.value.snapshotVersion,
                    observedAtEpochMs,
                    sessionLeaseFields: 'authoritative'
                });
            })
        );
        return {
            snapshots: resolved.filter((snapshot): snapshot is GroupSnapshot => snapshot !== undefined),
            scannedGroupCount: pageGroups.length,
            hasMore: page.hasMore,
            nextGroupKey: pageGroups.at(-1)?.entry.key
        };
    }

    private async readSnapshotPageGroups(
        scope: GroupScope,
        options: GroupSnapshotPageOptions
    ): Promise<GroupStateSnapshotPageScan> {
        const limit = Math.max(1, Math.floor(options.limit));
        const rawPageLimit = limit + 1;
        const pageGroups: GroupStateSnapshotPageGroup[] = [];
        let afterKey = options.afterKey;
        let hasMore = false;

        while (!hasMore) {
            const groupEntries = await this.listEntriesPage(
                GROUPS_NAMESPACE,
                `${groupStateScopeStorageKey(scope)}:`,
                { afterKey, limit: rawPageLimit }
            );
            if (groupEntries.length === 0) {
                break;
            }
            for (const entry of groupEntries) {
                afterKey = entry.key;
                const groupValue = await this.toLiveValue<unknown>(GROUPS_NAMESPACE, entry);
                if (groupValue === undefined) {
                    continue;
                }
                const group = canonicalStoredGroup({ entry, value: groupValue }, scope).value;
                if (pageGroups.length === limit) {
                    hasMore = true;
                    break;
                }
                pageGroups.push({ entry, group });
            }
            if (groupEntries.length < rawPageLimit) {
                break;
            }
        }
        return { groups: pageGroups, hasMore };
    }

    async readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        return (await this.readSnapshotWithAuthorityGuard(ref))?.snapshot;
    }

    async readSnapshotWithAuthorityGuard(
        ref: GroupRef
    ): Promise<GroupStateAuthoritativeSnapshot | undefined> {
        const observedAtEpochMs = Date.now();
        const groupKey = groupStateGroupStorageKey(ref);
        const batch = await readGroupStateAuthorityBatch(
            this.repository,
            ref,
            async (namespace, entry) => await this.toLiveEntryValue<unknown>(namespace, entry)
        );
        if (batch.status === 'stable') {
            if (batch.group === undefined) {
                return undefined;
            }
            const stored = canonicalStoredGroup(batch.group, ref);
            return {
                snapshot: this.toSnapshot({
                    group: stored.value,
                    members: batch.members.map((entry) => canonicalStoredMember(entry, ref).value),
                    summary: batch.summary === undefined
                        ? undefined
                        : canonicalStoredSummary(batch.summary, ref).value,
                    authoritativeSessions: batch.sessions.map(
                        (entry) => canonicalStoredSession(entry, ref).value
                    ),
                    groupRevision: stored.value.snapshotVersion,
                    observedAtEpochMs,
                    sessionLeaseFields: 'authoritative'
                }),
                authorityGuard: toGroupStateAuthorityGuard(ref, stored)
            };
        }
        return await readStableStateSnapshot({
            snapshotKey: groupKey,
            readAggregate: async () => await this.findGroupEntry(ref),
            readChildren: async () => {
                const [members, summary, sessions] = await Promise.all([
                    this.listMembers(ref),
                    this.findPresenceSummaryEntry(ref),
                    this.listPresenceSessions(ref)
                ]);
                return [members, { summary: summary?.value, sessions }] as const;
            },
            assemble: (stored, members, presence) => ({
                snapshot: this.toSnapshot({
                    group: stored.value,
                    members,
                    summary: presence.summary,
                    authoritativeSessions: presence.sessions,
                    groupRevision: stored.value.snapshotVersion,
                    observedAtEpochMs,
                    sessionLeaseFields: 'authoritative'
                }),
                authorityGuard: toGroupStateAuthorityGuard(ref, stored)
            })
        });
    }

    protected override async toLiveEntryValue<T>(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        void namespace;
        return await toLiveGroupStateEntryValue<T>(entry);
    }

    private toSnapshot(input: GroupStateSnapshotAssemblyInput): GroupSnapshot {
        return assembleGroupStateSnapshot(
            input,
            (storageKey, message) => new GroupStateRepositoryInvariantCorruptionError(storageKey, message)
        );
    }
}
