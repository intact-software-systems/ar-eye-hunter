import type {
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupScope,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { resolveRuntimeStateReadBatchLiveValues } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type { RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import { RuntimeStateJsonStore, type RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { readStableStateSnapshot, StateSnapshotReadConflictError } from '../../state-events/state-snapshot-read.ts';
import type { GroupSnapshotPage, GroupSnapshotPageOptions } from '../group-state-service-contracts.ts';
import { canonicalStoredGroup, toGroupStateAuthorityGuard } from './aggregate/group-aggregate-repository.ts';
import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from './aggregate/group-aggregate-storage-keys.ts';
import {
    assembleGroupStateSnapshot,
    collectGroupStateValuesByGroupId,
    type GroupStateScopeSnapshotRead,
    type GroupStateSnapshotAssemblyInput,
    type GroupStateSnapshotPageGroup,
    type GroupStateSnapshotPageScan
} from './assemble-group-state-snapshot.ts';
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
import { canonicalStoredMember } from './membership/group-membership-repository.ts';
import {
    decodeGroupStateMemberStorageKey,
    groupStateMemberStorageKey
} from './membership/group-membership-storage-key.ts';
import { canonicalStoredSession, canonicalStoredSummary } from './presence/group-presence-repository.ts';
import { decodeGroupStatePresenceSessionStorageKey } from './presence/group-presence-storage-keys.ts';
import { readGroupStateAuthorityBatch } from './read-group-state-authority.ts';

interface GroupStateAudienceChildren {
    readonly members: readonly GroupMember[];
    readonly summary: GroupPresenceSummary | undefined;
    readonly sessions: readonly GroupPresenceSession[];
}

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

    async listSnapshotsForPrincipal(
        scope: GroupScope,
        principalId: string
    ): Promise<readonly GroupSnapshot[]> {
        const observedAtEpochMs = Date.now();
        const keyPrefix = `${groupStateScopeStorageKey(scope)}:`;
        const groupsBefore = (await this.listJsonEntryValues(GROUPS_NAMESPACE, keyPrefix))
            .map((stored) => canonicalStoredGroup(stored, scope));
        const actorSelectors: readonly RuntimeStateReadBatchSelector[] = groupsBefore.map((stored, index) => ({
            selectorId: `actor:${index}`,
            kind: 'key',
            namespace: MEMBERS_NAMESPACE,
            key: groupStateMemberStorageKey({ ...stored.value, principalId })
        }));
        const actorSelections = actorSelectors.length === 0
            ? []
            : await this.readLiveBatchSelections(actorSelectors);
        const selected = groupsBefore.filter((stored, index) => {
            const actor = actorSelections[index]?.[0];
            return actor !== undefined &&
                canonicalStoredMember(actor, { ...stored.value, principalId }).value.status === 'active';
        });
        const selectedChildren = await this.readAudienceGroupChildren(selected);
        const groupsAfter = (await this.listJsonEntryValues(GROUPS_NAMESPACE, keyPrefix))
            .map((stored) => canonicalStoredGroup(stored, scope));
        const beforeByKey = new Map(groupsBefore.map((stored) => [stored.entry.key, stored]));
        const selectedByKey = new Map(selected.map((stored, index) => [stored.entry.key, selectedChildren[index]]));
        const snapshots = await Promise.all(groupsAfter.map(async (stored) => {
            const before = beforeByKey.get(stored.entry.key);
            if (!before || before.entry.revision !== stored.entry.revision) {
                return await this.readSnapshot(stored.value);
            }
            const children = selectedByKey.get(stored.entry.key);
            if (!children) {
                return undefined;
            }
            return this.toSnapshot({
                group: stored.value,
                members: children.members,
                summary: children.summary,
                authoritativeSessions: children.sessions,
                groupRevision: stored.value.snapshotVersion,
                observedAtEpochMs,
                sessionLeaseFields: 'authoritative'
            });
        }));
        return snapshots.filter((snapshot): snapshot is GroupSnapshot =>
            snapshot !== undefined &&
            snapshot.members.some((member) => member.principalId === principalId && member.status === 'active')
        );
    }

    private async readAudienceGroupChildren(
        groups: readonly RuntimeStateEntryValue<Group>[]
    ): Promise<readonly GroupStateAudienceChildren[]> {
        if (groups.length === 0) {
            return [];
        }
        const selectors: RuntimeStateReadBatchSelector[] = groups.flatMap((stored, index) => {
            const groupKey = groupStateGroupStorageKey(stored.value);
            return [
                {
                    selectorId: `members:${index}`,
                    kind: 'prefix',
                    namespace: MEMBERS_NAMESPACE,
                    keyPrefix: `${groupKey}:`
                },
                { selectorId: `summary:${index}`, kind: 'key', namespace: PRESENCE_SUMMARIES_NAMESPACE, key: groupKey },
                {
                    selectorId: `sessions:${index}`,
                    kind: 'prefix',
                    namespace: SESSIONS_NAMESPACE,
                    keyPrefix: `${groupKey}:`
                }
            ];
        });
        const selections = await this.readLiveBatchSelections(selectors);
        return groups.map((stored, index) => ({
            members: selections[index * 3].map((entry) => canonicalStoredMember(entry, stored.value).value),
            summary: selections[index * 3 + 1][0] === undefined
                ? undefined
                : canonicalStoredSummary(selections[index * 3 + 1][0], stored.value).value,
            sessions: selections[index * 3 + 2].map((entry) => canonicalStoredSession(entry, stored.value).value)
        }));
    }

    private async readLiveBatchSelections(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly (readonly RuntimeStateEntryValue<JsonWireValue>[])[]> {
        const resolved = await resolveRuntimeStateReadBatchLiveValues(
            selectors,
            await this.repository.readRuntimeStateBatch(selectors),
            async (namespace, entry) => await this.toLiveJsonEntryValue(namespace, entry)
        );
        if (resolved.status === 'changed') {
            throw new StateSnapshotReadConflictError(
                selectors[0].kind === 'key' ? selectors[0].key : selectors[0].keyPrefix
            );
        }
        return resolved.selections.map((selection) => selection.entries);
    }

    private async readScopeSnapshot(scope: GroupScope): Promise<GroupStateScopeSnapshotRead> {
        const keyPrefix = `${groupStateScopeStorageKey(scope)}:`;
        const groupsBeforeRaw = await this.listJsonEntryValues(GROUPS_NAMESPACE, keyPrefix);
        const [memberEntriesRaw, summaryEntriesRaw, sessionEntriesRaw] = await Promise.all([
            this.listJsonEntryValues(MEMBERS_NAMESPACE, keyPrefix),
            this.listJsonEntryValues(PRESENCE_SUMMARIES_NAMESPACE, keyPrefix),
            this.listJsonEntryValues(SESSIONS_NAMESPACE, keyPrefix)
        ]);
        const groupsAfterRaw = await this.listJsonEntryValues(GROUPS_NAMESPACE, keyPrefix);
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
        const groupsAfterRaw = await this.listJsonEntryValuesByKeys(
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
                const groupValue = await this.toLiveJsonValue(GROUPS_NAMESPACE, entry);
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
            async (namespace, entry) => await this.toLiveJsonEntryValue(namespace, entry)
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

    protected override async toLiveJsonEntryValue(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<JsonWireValue> | undefined> {
        void namespace;
        return await toLiveGroupStateEntryValue(entry);
    }

    private toSnapshot(input: GroupStateSnapshotAssemblyInput): GroupSnapshot {
        return assembleGroupStateSnapshot(
            input,
            (storageKey, message) => new GroupStateRepositoryInvariantCorruptionError(storageKey, message)
        );
    }
}
