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
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { StateSnapshotReadConflictError } from '../../state-events/state-snapshot-read.ts';
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

interface PrincipalGroupRead {
    readonly selection: PrincipalGroupSelection;
    readonly children: PrincipalGroupChildren;
}

export async function readGroupStateSnapshotsForPrincipal(
    input: ReadGroupStateSnapshotsForPrincipalInput
): Promise<readonly GroupSnapshot[]> {
    const selectedBefore = await readPrincipalGroupSelections(input);
    const children = await readPrincipalGroupChildren(input.repository, selectedBefore);
    const readByGroupKey = new Map<string, PrincipalGroupRead>(
        selectedBefore.map((
            selection,
            index
        ) => [selection.group.entry.key, { selection, children: children[index] }])
    );
    const selectedAfter = await readPrincipalGroupSelections(input);
    const snapshots = await Promise.all(selectedAfter.map(async (selection) => {
        const read = readByGroupKey.get(selection.group.entry.key);
        return read === undefined || !isSamePrincipalGroupSelection(read.selection, selection)
            ? await input.readSnapshot(selection.group.value)
            : toPrincipalGroupSnapshot(
                selection.group.value,
                read.children,
                input.observedAtEpochMs
            );
    }));
    return snapshots.filter((snapshot): snapshot is GroupSnapshot =>
        snapshot !== undefined &&
        snapshot.members.some((member) => member.principalId === input.principalId && member.status === 'active')
    );
}

async function readPrincipalGroupSelections(
    input: ReadGroupStateSnapshotsForPrincipalInput
): Promise<readonly PrincipalGroupSelection[]> {
    const [storedMembers] = await readLiveSelections(input.repository, [{
        selectorId: 'principal-members',
        kind: 'prefix-suffix',
        namespace: MEMBERS_NAMESPACE,
        keyPrefix: `${groupStateScopeStorageKey(input.scope)}:`,
        keySuffix: groupStateMemberStorageKeySuffix(input.principalId)
    }]);
    const activeMembers = storedMembers
        .map((stored) => toPrincipalMember(stored, input))
        .filter((member) => member.value.status === 'active');
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
        }))
    );
    return activeMembers.flatMap((member, index) => {
        const [storedGroup] = storedGroups[index];
        return storedGroup === undefined
            ? []
            : [{ member, group: canonicalStoredGroup(storedGroup, toGroupRef(member.value)) }];
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
    selections: readonly PrincipalGroupSelection[]
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
        })
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
    selectors: readonly RuntimeStateReadBatchSelector[]
): Promise<readonly (readonly RuntimeStateEntryValue<JsonWireValue>[])[]> {
    const resolved = await resolveRuntimeStateReadBatchLiveValues(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        async (_namespace, entry) => await toLiveGroupStateEntryValue(entry)
    );
    if (resolved.status === 'changed') {
        throw new StateSnapshotReadConflictError(
            selectors[0].kind === 'key' ? selectors[0].key : selectors[0].keyPrefix
        );
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
