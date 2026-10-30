import {
    comparePublicationGrantPrincipalIds,
    type GroupPublicationGrant
} from '@shared/api/group-publication/group-publication-grants.ts';
import type {
    GroupMember,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupScope,
    GroupSnapshot
} from '@shared/api/group-types.ts';

import type {
    RuntimeStateReadBatchVersion,
    RuntimeStateReadBatchVersionReader
} from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import { RuntimeStateJsonStore, type RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupSnapshotPage, GroupSnapshotPageOptions } from '../group-state-service-contracts.ts';
import type { GroupStateCurrentSnapshotCache } from '../snapshot/group-state-current-snapshot-cache.ts';
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
    PUBLICATION_GRANTS_NAMESPACE
} from './group-state-runtime-namespaces.ts';
import { canonicalStoredMember } from './membership/group-membership-repository.ts';
import { decodeGroupStateMemberStorageKey } from './membership/group-membership-storage-key.ts';
import { canonicalStoredSession, canonicalStoredSummary } from './presence/group-presence-repository.ts';
import { decodeGroupStatePresenceSessionStorageKey } from './presence/group-presence-storage-keys.ts';
import {
    canonicalStoredPublicationGrant,
    canonicalStoredPublicationGrants
} from './publication/group-publication-grant-codec.ts';
import { decodeGroupStatePublicationGrantStorageKey } from './publication/group-publication-grant-storage-key.ts';
import {
    readGroupStateAuthorityBatch,
    readVersionedGroupStateSnapshotBatch,
    toLivePresenceSessionsSelector,
    type GroupStateAuthorityBatchRead
} from './read-group-state-authority.ts';
import {
    readGroupStateSnapshotsForPrincipal,
    type GroupStatePrincipalSnapshotList
} from './read-group-state-snapshots-for-principal.ts';

/**
 * A snapshot, or undefined for a group without a live row, and the version of exactly the stored rows the read selected;
 * null when no row was selected. An absent group is versioned by the rows it leaves, such as its member rows.
 */
export interface VersionedGroupSnapshot {
    readonly snapshot: GroupSnapshot | undefined;
    readonly version: RuntimeStateReadBatchVersion | null;
}

/** One page group's children, as read before the group was read again. */
interface GroupStateSnapshotPageCandidate {
    readonly entry: GroupStateSnapshotPageGroup['entry'];
    readonly members: readonly GroupMember[];
    readonly summary: GroupPresenceSummary | undefined;
    readonly sessions: readonly GroupPresenceSession[];
    readonly publicationGrants: readonly GroupPublicationGrant[];
}

export abstract class GroupStateSnapshotRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    protected abstract listMembers(ref: GroupRef): Promise<readonly GroupMember[]>;

    protected abstract findPresenceSummaryEntry(
        ref: GroupRef
    ): Promise<RuntimeStateEntryValue<GroupPresenceSummary> | undefined>;

    async listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]> {
        const observedAtEpochMs = Date.now();
        const read = await this.readScopeSnapshot(scope, observedAtEpochMs);
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
                    publicationGrants: read.publicationGrantsByGroupId.get(stored.value.groupId) ?? [],
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
        principalId: string,
        currentSnapshots?: Pick<GroupStateCurrentSnapshotCache, 'readSnapshots'>
    ): Promise<readonly GroupSnapshot[]> {
        return (await this.readSnapshotListForPrincipal(scope, principalId, currentSnapshots)).snapshots;
    }

    /** The principal's groups with the statements the read issued, for a caller that records them. */
    async readSnapshotListForPrincipal(
        scope: GroupScope,
        principalId: string,
        currentSnapshots: Pick<GroupStateCurrentSnapshotCache, 'readSnapshots'> | undefined
    ): Promise<GroupStatePrincipalSnapshotList> {
        return await readGroupStateSnapshotsForPrincipal({
            repository: this.repository,
            scope,
            principalId,
            observedAtEpochMs: Date.now(),
            readSnapshot: async (ref) => await this.readSnapshot(ref),
            currentSnapshots
        });
    }

    private async readScopeSnapshot(
        scope: GroupScope,
        observedAtEpochMs: number
    ): Promise<GroupStateScopeSnapshotRead> {
        const keyPrefix = `${groupStateScopeStorageKey(scope)}:`;
        const groupsBeforeRaw = await this.listJsonEntryValues(GROUPS_NAMESPACE, keyPrefix);
        const [memberEntriesRaw, summaryEntriesRaw, sessionEntriesRaw, grantEntriesRaw] = await Promise.all([
            this.listJsonEntryValues(MEMBERS_NAMESPACE, keyPrefix),
            this.listJsonEntryValues(PRESENCE_SUMMARIES_NAMESPACE, keyPrefix),
            this.listSelectedJsonEntryValues(toLivePresenceSessionsSelector(keyPrefix, observedAtEpochMs)),
            this.listJsonEntryValues(PUBLICATION_GRANTS_NAMESPACE, keyPrefix)
        ]);
        const groupsAfterRaw = await this.listJsonEntryValues(GROUPS_NAMESPACE, keyPrefix);
        const groupsBefore = groupsBeforeRaw.flatMap((stored) => canonicalStoredGroup(stored, scope) ?? []);
        const groupsAfter = groupsAfterRaw.flatMap((stored) => canonicalStoredGroup(stored, scope) ?? []);
        const members = memberEntriesRaw.map((stored) => toScopeMember(stored, scope));
        const summaries = summaryEntriesRaw.map((stored) => toScopeSummary(stored, scope));
        const sessions = sessionEntriesRaw.map((stored) => toScopeSession(stored, scope));
        const grants = grantEntriesRaw.map((stored) => toScopePublicationGrant(stored, scope));
        return {
            groupsBefore,
            groupsAfter,
            membersByGroupId: collectGroupStateValuesByGroupId(members),
            summariesByGroupId: new Map(summaries.map((summary) => [summary.groupId, summary])),
            sessionsByGroupId: collectGroupStateValuesByGroupId(sessions),
            publicationGrantsByGroupId: new Map(
                [...collectGroupStateValuesByGroupId(grants)].map(([groupId, values]) => [
                    groupId,
                    values.sort((left, right) =>
                        comparePublicationGrantPrincipalIds(left.principalId, right.principalId)
                    )
                ])
            )
        };
    }

    async listSnapshotsPage(
        scope: GroupScope,
        options: GroupSnapshotPageOptions
    ): Promise<GroupSnapshotPage> {
        const observedAtEpochMs = Date.now();
        const page = await this.readSnapshotPageGroups(scope, options);
        const candidates = await this.readSnapshotPageCandidates(page.groups, observedAtEpochMs);
        const groupsAfterRaw = await this.listJsonEntryValuesByKeys(
            GROUPS_NAMESPACE,
            page.groups.map(({ entry }) => entry.key)
        );
        const groupsAfter = groupsAfterRaw.flatMap((stored) => canonicalStoredGroup(stored, scope) ?? []);
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
                    publicationGrants: candidate.publicationGrants,
                    groupRevision: after.value.snapshotVersion,
                    observedAtEpochMs,
                    sessionLeaseFields: 'authoritative'
                });
            })
        );
        return {
            snapshots: resolved.filter((snapshot): snapshot is GroupSnapshot => snapshot !== undefined),
            scannedGroupCount: page.groups.length,
            hasMore: page.hasMore,
            nextGroupKey: page.groups.at(-1)?.entry.key
        };
    }

    /** Each page group's children, read before the groups are read again to find the ones that changed meanwhile. */
    private async readSnapshotPageCandidates(
        pageGroups: readonly GroupStateSnapshotPageGroup[],
        observedAtEpochMs: number
    ): Promise<readonly GroupStateSnapshotPageCandidate[]> {
        return await Promise.all(
            pageGroups.map(async ({ entry, group }) => {
                const [members, summary, sessions] = await Promise.all([
                    this.listMembers(group),
                    this.findPresenceSummaryEntry(group),
                    this.readLivePresenceSessions(group, observedAtEpochMs)
                ]);
                const publicationGrants = await this.listPublicationGrants(group);
                return { entry, members, summary: summary?.value, sessions, publicationGrants };
            })
        );
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
                const group = canonicalStoredGroup({ entry, value: groupValue }, scope)?.value;
                if (group === undefined) {
                    continue;
                }
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
        const batch = await readGroupStateAuthorityBatch(
            this.repository,
            ref,
            observedAtEpochMs
        );
        return this.toStableAuthoritativeSnapshot(ref, batch, observedAtEpochMs);
    }

    /**
     * The snapshot as of the caller's instant with the version of exactly the rows it was assembled from, read in
     * one statement; a read selecting no row carries no version.
     */
    async readVersionedSnapshot(
        reader: RuntimeStateReadBatchVersionReader,
        ref: GroupRef,
        observedAtEpochMs: number
    ): Promise<VersionedGroupSnapshot> {
        const batch = await readVersionedGroupStateSnapshotBatch({
            reader,
            ref,
            observedAtEpochMs
        });
        const stable = this.toStableAuthoritativeSnapshot(ref, batch.read, observedAtEpochMs);
        return { snapshot: stable?.snapshot, version: batch.version ?? null };
    }

    protected toStableAuthoritativeSnapshot(
        ref: GroupRef,
        batch: GroupStateAuthorityBatchRead,
        observedAtEpochMs: number
    ): GroupStateAuthoritativeSnapshot | undefined {
        if (batch.group === undefined) {
            return undefined;
        }
        const stored = canonicalStoredGroup(batch.group, ref);
        if (stored === undefined) {
            return undefined;
        }
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
                publicationGrants: batch.publicationGrants.map((entry) => entry.value),
                groupRevision: stored.value.snapshotVersion,
                observedAtEpochMs,
                sessionLeaseFields: 'authoritative'
            }),
            authorityGuard: toGroupStateAuthorityGuard(ref, stored)
        };
    }

    private async listPublicationGrants(ref: GroupRef): Promise<readonly GroupPublicationGrant[]> {
        const stored = await this.listJsonEntryValues(
            PUBLICATION_GRANTS_NAMESPACE,
            `${groupStateGroupStorageKey(ref)}:`
        );
        return canonicalStoredPublicationGrants(stored, ref).map((entry) => entry.value);
    }

    private async readLivePresenceSessions(
        ref: GroupRef,
        observedAtEpochMs: number
    ): Promise<readonly GroupPresenceSession[]> {
        const stored = await this.listSelectedJsonEntryValues(
            toLivePresenceSessionsSelector(`${groupStateGroupStorageKey(ref)}:`, observedAtEpochMs)
        );
        return stored.map((entry) => canonicalStoredSession(entry, ref).value);
    }

    protected override async toLiveJsonEntryValue(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<JsonWireValue> | undefined> {
        const observedAtEpochMs = Date.now();
        return toLiveGroupStateEntryValue(namespace, entry, observedAtEpochMs);
    }

    private toSnapshot(input: GroupStateSnapshotAssemblyInput): GroupSnapshot {
        return assembleGroupStateSnapshot(
            input,
            (storageKey, message) => new GroupStateRepositoryInvariantCorruptionError(storageKey, message)
        );
    }
}

function toScopeMember(stored: RuntimeStateEntryValue<JsonWireValue>, scope: GroupScope): GroupMember {
    assertDecodedGroupScope(
        decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateMemberStorageKey),
        scope,
        stored.entry.key
    );
    return canonicalStoredMember(stored).value;
}

function toScopeSummary(stored: RuntimeStateEntryValue<JsonWireValue>, scope: GroupScope): GroupPresenceSummary {
    const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateGroupStorageKey);
    assertDecodedGroupScope(decoded, scope, stored.entry.key);
    return canonicalStoredSummary(stored, decoded).value;
}

function toScopePublicationGrant(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    scope: GroupScope
): GroupPublicationGrant {
    const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStatePublicationGrantStorageKey);
    assertDecodedGroupScope(decoded, scope, stored.entry.key);
    return canonicalStoredPublicationGrant(stored, decoded).value;
}

function toScopeSession(stored: RuntimeStateEntryValue<JsonWireValue>, scope: GroupScope): GroupPresenceSession {
    const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStatePresenceSessionStorageKey);
    assertDecodedGroupScope(decoded, scope, stored.entry.key);
    return canonicalStoredSession(stored).value;
}
