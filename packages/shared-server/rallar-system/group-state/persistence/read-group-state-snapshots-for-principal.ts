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
import { toRuntimeStateReadBatchSelectedKey } from '../../../runtime-state/read-batch/to-runtime-state-read-batch-selected-key.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { StateSnapshotReadConflictError } from '../../state-events/state-snapshot-read.ts';
import type { GroupStateCurrentSnapshotCache } from '../snapshot/group-state-current-snapshot-cache.ts';
import { canonicalStoredGroup } from './aggregate/group-aggregate-repository.ts';
import {
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from './aggregate/group-aggregate-storage-keys.ts';
import { assembleGroupStateSnapshot } from './assemble-group-state-snapshot.ts';
import {
    assertDecodedGroupScope,
    decodeStoredGroupStateKey,
    GroupStateRepositoryInvariantCorruptionError,
    toLiveGroupStateEntryValue
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
    groupStateMemberStorageKeySuffix
} from './membership/group-membership-storage-key.ts';
import {
    canonicalStoredSession,
    canonicalStoredSummary
} from './presence/group-presence-repository.ts';

export interface ReadGroupStateSnapshotsForPrincipalInput {
    readonly repository: RuntimeStateRepositoryLike;
    readonly scope: GroupScope;
    readonly principalId: string;
    readonly observedAtEpochMs: number;
    readonly readSnapshot: (ref: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly currentSnapshots?: Pick<GroupStateCurrentSnapshotCache, 'readSnapshots'>;
}

interface PrincipalGroupSelection {
    readonly member: RuntimeStateEntryValue<GroupMember>;
    readonly group: RuntimeStateEntryValue<Group>;
}

interface PrincipalGroupChildren {
    readonly members: readonly GroupMember[];
    readonly summary: GroupPresenceSummary | undefined;
    readonly sessions: readonly GroupPresenceSession[];
}

/** A principal's groups and what the read cost: one statement per selection, revision probe, full read and fallback. */
export interface GroupStatePrincipalSnapshotList {
    readonly snapshots: readonly GroupSnapshot[];
    /** The active member rows of the first selection: the index rows read in place of every group of the scope. */
    readonly selectedMembers: number;
    /** A full read that fell back to several statements counts once. */
    readonly statements: number;
    /** The groups read again from current authority because a selected row moved between the two selections. */
    readonly fallbackReads: number;
}

/** The statements one list issued, accumulated as it reads. */
interface PrincipalListTally {
    statements: number;
    fallbackReads: number;
}

export async function readGroupStateSnapshotsForPrincipal(
    input: ReadGroupStateSnapshotsForPrincipalInput
): Promise<GroupStatePrincipalSnapshotList> {
    const tally: PrincipalListTally = { statements: 0, fallbackReads: 0 };
    const read = input.currentSnapshots === undefined
        ? await readAssembledPrincipalSnapshots(input, tally)
        : await readCurrentPrincipalSnapshots(input, input.currentSnapshots, tally);
    return {
        snapshots: read.snapshots.filter((snapshot): snapshot is GroupSnapshot =>
            snapshot !== undefined &&
            snapshot.members.some((member) => member.principalId === input.principalId && member.status === 'active')
        ),
        selectedMembers: read.selectedMembers,
        statements: tally.statements,
        fallbackReads: tally.fallbackReads
    };
}

interface PrincipalGroupReads {
    readonly snapshots: readonly (GroupSnapshot | undefined)[];
    readonly selectedMembers: number;
}

/** The principal's active member rows and the live group rows of the groups asked, from one read. */
interface PrincipalMembersAndGroups {
    readonly members: readonly RuntimeStateEntryValue<GroupMember>[];
    readonly groupsByKey: ReadonlyMap<string, Group>;
}

/**
 * The first selection reads member rows only: a current snapshot is one consistent read of the group row with its
 * children. The second selection runs alongside the snapshot read and reads the member rows again with the group row of
 * each group the first selected; a group whose member row moved, or whose group row was written past the snapshot, is
 * read again from current authority, and one whose group row is gone is not listed.
 */
async function readCurrentPrincipalSnapshots(
    input: ReadGroupStateSnapshotsForPrincipalInput,
    currentSnapshots: Pick<GroupStateCurrentSnapshotCache, 'readSnapshots'>,
    tally: PrincipalListTally
): Promise<PrincipalGroupReads> {
    const membersBefore = await readActivePrincipalMembers(input, tally);
    const refs = membersBefore.map((member) => toGroupRef(member.value));
    const [current, after] = await Promise.all([
        currentSnapshots.readSnapshots(refs),
        readPrincipalMembersAndGroups(input, refs, tally)
    ]);
    tally.statements += current.probes + current.reads;
    const readByGroupKey = new Map(membersBefore.map((member, index) => [
        groupStateGroupStorageKey(member.value),
        { member, snapshot: current.snapshots[index] }
    ]));
    const snapshots = await Promise.all(after.members.map(async (member) => {
        const groupKey = groupStateGroupStorageKey(member.value);
        const read = readByGroupKey.get(groupKey);
        if (read === undefined || read.member.entry.revision !== member.entry.revision) {
            return await readFallbackSnapshot(input, toGroupRef(member.value), tally);
        }
        const group = after.groupsByKey.get(groupKey);
        if (group === undefined) {
            return undefined;
        }
        return read.snapshot?.group.snapshotVersion === group.snapshotVersion
            ? read.snapshot
            : await readFallbackSnapshot(input, toGroupRef(member.value), tally);
    }));
    return { snapshots, selectedMembers: membersBefore.length };
}

/** Assembles each group from its children, read between two selections of the member and group rows. */
async function readAssembledPrincipalSnapshots(
    input: ReadGroupStateSnapshotsForPrincipalInput,
    tally: PrincipalListTally
): Promise<PrincipalGroupReads> {
    const selectedBefore = await readPrincipalGroupSelections(input, tally);
    const children = await readPrincipalGroupChildren(input.repository, selectedBefore, tally);
    const readByGroupKey = new Map(selectedBefore.map((selection, index) => [
        selection.group.entry.key,
        { selection, children: children[index]! }
    ]));
    const selectedAfter = await readPrincipalGroupSelections(input, tally);
    const snapshots = await Promise.all(selectedAfter.map(async (selection) => {
        const read = readByGroupKey.get(selection.group.entry.key);
        return read === undefined || !isSamePrincipalGroupSelection(read.selection, selection)
            ? await readFallbackSnapshot(input, selection.group.value, tally)
            : toPrincipalGroupSnapshot(selection.group.value, read.children, input.observedAtEpochMs);
    }));
    return { snapshots, selectedMembers: selectedBefore.length };
}

async function readFallbackSnapshot(
    input: ReadGroupStateSnapshotsForPrincipalInput,
    ref: GroupRef,
    tally: PrincipalListTally
): Promise<GroupSnapshot | undefined> {
    tally.statements += 1;
    tally.fallbackReads += 1;
    return await input.readSnapshot(ref);
}

async function readActivePrincipalMembers(
    input: ReadGroupStateSnapshotsForPrincipalInput,
    tally: PrincipalListTally
): Promise<readonly RuntimeStateEntryValue<GroupMember>[]> {
    const [storedMembers] = await readLiveSelections(input.repository, [toPrincipalMembersSelector(input)], tally);
    return toActivePrincipalMembers(storedMembers!, input);
}

function toPrincipalMembersSelector(input: ReadGroupStateSnapshotsForPrincipalInput): RuntimeStateReadBatchSelector {
    return {
        selectorId: 'principal-members',
        kind: 'prefix-suffix',
        namespace: MEMBERS_NAMESPACE,
        keyPrefix: `${groupStateScopeStorageKey(input.scope)}:`,
        keySuffix: groupStateMemberStorageKeySuffix(input.principalId)
    };
}

function toActivePrincipalMembers(
    storedMembers: readonly RuntimeStateEntryValue<JsonWireValue>[],
    input: ReadGroupStateSnapshotsForPrincipalInput
): readonly RuntimeStateEntryValue<GroupMember>[] {
    return storedMembers
        .map((stored) => toPrincipalMember(stored, input))
        .filter((member) => member.value.status === 'active');
}

async function readPrincipalMembersAndGroups(
    input: ReadGroupStateSnapshotsForPrincipalInput,
    refs: readonly GroupRef[],
    tally: PrincipalListTally
): Promise<PrincipalMembersAndGroups> {
    const [storedMembers, ...storedGroups] = await readLiveSelections(
        input.repository,
        [
            toPrincipalMembersSelector(input),
            ...refs.map((ref, index): RuntimeStateReadBatchSelector => ({
                selectorId: `group:${index}`,
                kind: 'key',
                namespace: GROUPS_NAMESPACE,
                key: groupStateGroupStorageKey(ref)
            }))
        ],
        tally
    );
    return {
        members: toActivePrincipalMembers(storedMembers!, input),
        groupsByKey: new Map(refs.flatMap((ref, index) => {
            const [storedGroup] = storedGroups[index]!;
            const group = storedGroup === undefined ? undefined : canonicalStoredGroup(storedGroup, ref);
            return group === undefined ? [] : [[groupStateGroupStorageKey(ref), group.value]];
        }))
    };
}

async function readPrincipalGroupSelections(
    input: ReadGroupStateSnapshotsForPrincipalInput,
    tally: PrincipalListTally
): Promise<readonly PrincipalGroupSelection[]> {
    const activeMembers = await readActivePrincipalMembers(input, tally);
    if (activeMembers.length === 0) {
        return [];
    }
    const storedGroups = await readLiveSelections(
        input.repository,
        activeMembers.map((member, index) => ({
            selectorId: `group:${index}`,
            kind: 'key',
            namespace: GROUPS_NAMESPACE,
            key: groupStateGroupStorageKey(member.value)
        })),
        tally
    );
    return activeMembers.flatMap((member, index) => {
        const [storedGroup] = storedGroups[index];
        const group = storedGroup === undefined
            ? undefined
            : canonicalStoredGroup(storedGroup, toGroupRef(member.value));
        return group === undefined ? [] : [{ member, group }];
    });
}

function toPrincipalMember(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    input: ReadGroupStateSnapshotsForPrincipalInput
): RuntimeStateEntryValue<GroupMember> {
    const decoded = decodeStoredGroupStateKey(stored.entry.key, decodeGroupStateMemberStorageKey);
    assertDecodedGroupScope(decoded, input.scope, stored.entry.key);
    return canonicalStoredMember(stored, {
        ...toGroupRef(decoded),
        principalId: input.principalId
    });
}

async function readPrincipalGroupChildren(
    repository: RuntimeStateRepositoryLike,
    selections: readonly PrincipalGroupSelection[],
    tally: PrincipalListTally
): Promise<readonly PrincipalGroupChildren[]> {
    if (selections.length === 0) {
        return [];
    }
    const read = await readLiveSelections(
        repository,
        selections.flatMap(({ group }, index) => {
            const groupKey = groupStateGroupStorageKey(group.value);
            return [
                {
                    selectorId: `members:${index}`,
                    kind: 'prefix',
                    namespace: MEMBERS_NAMESPACE,
                    keyPrefix: `${groupKey}:`
                },
                {
                    selectorId: `summary:${index}`,
                    kind: 'key',
                    namespace: PRESENCE_SUMMARIES_NAMESPACE,
                    key: groupKey
                },
                {
                    selectorId: `sessions:${index}`,
                    kind: 'prefix',
                    namespace: SESSIONS_NAMESPACE,
                    keyPrefix: `${groupKey}:`
                }
            ] satisfies RuntimeStateReadBatchSelector[];
        }),
        tally
    );
    return selections.map(({ group }, index) => {
        const [summary] = read[index * 3 + 1];
        return {
            members: read[index * 3].map((entry) => canonicalStoredMember(entry, group.value).value),
            summary: summary === undefined
                ? undefined
                : canonicalStoredSummary(summary, group.value).value,
            sessions: read[index * 3 + 2].map((entry) => canonicalStoredSession(entry, group.value).value)
        };
    });
}

async function readLiveSelections(
    repository: RuntimeStateRepositoryLike,
    selectors: readonly RuntimeStateReadBatchSelector[],
    tally: PrincipalListTally
): Promise<readonly (readonly RuntimeStateEntryValue<JsonWireValue>[])[]> {
    tally.statements += 1;
    const observedAtEpochMs = Date.now();
    const resolved = await resolveRuntimeStateReadBatchLiveValues(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        async (namespace, entry) => toLiveGroupStateEntryValue(namespace, entry, observedAtEpochMs)
    );
    if (resolved.status === 'changed') {
        throw new StateSnapshotReadConflictError(toRuntimeStateReadBatchSelectedKey(selectors[0]));
    }
    return resolved.selections.map((selection) => selection.entries);
}

function isSamePrincipalGroupSelection(
    before: PrincipalGroupSelection,
    after: PrincipalGroupSelection
): boolean {
    return before.group.entry.revision === after.group.entry.revision &&
        before.member.entry.revision === after.member.entry.revision;
}

function toPrincipalGroupSnapshot(
    group: Group,
    children: PrincipalGroupChildren,
    observedAtEpochMs: number
): GroupSnapshot {
    return assembleGroupStateSnapshot(
        {
            group,
            members: children.members,
            summary: children.summary,
            authoritativeSessions: children.sessions,
            groupRevision: group.snapshotVersion,
            observedAtEpochMs,
            sessionLeaseFields: 'authoritative'
        },
        (storageKey, message) => new GroupStateRepositoryInvariantCorruptionError(storageKey, message)
    );
}

function toGroupRef(ref: GroupRef): GroupRef {
    return { applicationId: ref.applicationId, workspaceId: ref.workspaceId, groupId: ref.groupId };
}
