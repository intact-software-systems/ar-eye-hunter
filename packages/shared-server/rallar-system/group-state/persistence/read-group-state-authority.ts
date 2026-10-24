import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector,
    RuntimeStateReadBatchVersion,
    RuntimeStateReadBatchVersionReader
} from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { toSessionPurgeAfterEpochMs } from '../../presence/session-expiry.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { groupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';
import { toGroupStateReadBatchLiveSelections } from './group-state-persistence-contracts.ts';
import {
    GROUPS_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';

export interface GroupStateAuthorityBatchRead {
    readonly group: RuntimeStateEntryValue<JsonWireValue> | undefined;
    readonly members: readonly RuntimeStateEntryValue<JsonWireValue>[];
    readonly summary: RuntimeStateEntryValue<JsonWireValue> | undefined;
    readonly sessions: readonly RuntimeStateEntryValue<JsonWireValue>[];
}

export interface VersionedGroupStateSnapshotBatchRead {
    readonly read: GroupStateAuthorityBatchRead;
    /** The version of the rows the read came from; undefined when it found none. */
    readonly version: RuntimeStateReadBatchVersion | undefined;
}

export async function readGroupStateAuthorityBatch(
    repository: RuntimeStateRepositoryLike,
    ref: GroupRef,
    observedAtEpochMs: number
): Promise<GroupStateAuthorityBatchRead> {
    const selectors = toGroupStateAuthoritySelectors(ref);
    return toGroupStateAuthorityBatchRead(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        observedAtEpochMs
    );
}

export interface ReadVersionedGroupStateSnapshotBatchInput {
    readonly reader: RuntimeStateReadBatchVersionReader;
    readonly ref: GroupRef;
    readonly observedAtEpochMs: number;
}

/** A group snapshot's rows at the instant, with the version of exactly those rows, from one statement. */
export async function readVersionedGroupStateSnapshotBatch(
    input: ReadVersionedGroupStateSnapshotBatchInput
): Promise<VersionedGroupStateSnapshotBatchRead> {
    const selectors = toGroupStateSnapshotSelectors(input.ref, input.observedAtEpochMs);
    const batch = await input.reader.readRuntimeStateBatchWithVersion(selectors);
    return {
        read: toGroupStateAuthorityBatchRead(selectors, batch.selections, input.observedAtEpochMs),
        version: batch.version
    };
}

function toGroupStateAuthorityBatchRead(
    selectors: readonly RuntimeStateReadBatchSelector[],
    selections: readonly RuntimeStateReadBatchSelection[],
    observedAtEpochMs: number
): GroupStateAuthorityBatchRead {
    const [group, members, summary, sessions] = toGroupStateReadBatchLiveSelections(
        selectors,
        selections,
        observedAtEpochMs
    );
    return {
        group: group.entries[0],
        members: members.entries,
        summary: summary.entries[0],
        sessions: sessions.entries
    };
}

/**
 * The version of exactly the rows a snapshot read at the instant reads, for each group, without their values and in
 * one read.
 */
export async function readGroupStateSnapshotVersions(
    reader: RuntimeStateReadBatchVersionReader,
    refs: readonly GroupRef[],
    observedAtEpochMs: number
): Promise<readonly (RuntimeStateReadBatchVersion['version'] | undefined)[]> {
    return await reader.readRuntimeStateBatchVersions(
        refs.map((ref) => toGroupStateSnapshotSelectors(ref, observedAtEpochMs))
    );
}

/**
 * The authority rows, but only the presence sessions whose lease outlasts the instant: a session's row stays until a day
 * after its lease ends or it disconnects, so a row purged no later than a lease ending now shows no live session. The
 * mutation reads keep every row, which their cleanup needs.
 */
function toGroupStateSnapshotSelectors(
    ref: GroupRef,
    observedAtEpochMs: number
): readonly RuntimeStateReadBatchSelector[] {
    const [group, members, summary] = toGroupStateAuthoritySelectors(ref);
    return [
        group,
        members,
        summary,
        toLivePresenceSessionsSelector(`${groupStateGroupStorageKey(ref)}:`, observedAtEpochMs)
    ];
}

/** The presence sessions under the key prefix, a group's or a scope's, whose lease outlasts the instant. */
export function toLivePresenceSessionsSelector(
    keyPrefix: string,
    observedAtEpochMs: number
): RuntimeStateReadBatchSelector {
    return {
        selectorId: 'presence-sessions',
        kind: 'prefix-expiring-after',
        namespace: SESSIONS_NAMESPACE,
        keyPrefix,
        expiringAfterTimestamp: toSessionPurgeAfterEpochMs(observedAtEpochMs)
    };
}

/** The authority selectors and the group's presence admissions, which the presence summary also reads. */
export function toGroupPresenceSummarySelectors(ref: GroupRef): readonly RuntimeStateReadBatchSelector[] {
    return [
        ...toGroupStateAuthoritySelectors(ref),
        {
            selectorId: 'presence-admissions',
            kind: 'prefix',
            namespace: PRESENCE_ADMISSIONS_NAMESPACE,
            keyPrefix: `${groupStateGroupStorageKey(ref)}:`
        }
    ];
}

/**
 * Every row of the group's authority: the group, its roster, its presence summary and all its presence sessions, which
 * the mutation, authority-guard and presence-summary reads need. A snapshot reads `toGroupStateSnapshotSelectors`.
 */
export function toGroupStateAuthoritySelectors(ref: GroupRef): readonly RuntimeStateReadBatchSelector[] {
    const groupKey = groupStateGroupStorageKey(ref);
    const childPrefix = `${groupKey}:`;
    return [
        {
            selectorId: 'group',
            kind: 'key',
            namespace: GROUPS_NAMESPACE,
            key: groupKey
        },
        {
            selectorId: 'members',
            kind: 'prefix',
            namespace: MEMBERS_NAMESPACE,
            keyPrefix: childPrefix
        },
        {
            selectorId: 'presence-summary',
            kind: 'key',
            namespace: PRESENCE_SUMMARIES_NAMESPACE,
            key: groupKey
        },
        {
            selectorId: 'presence-sessions',
            kind: 'prefix',
            namespace: SESSIONS_NAMESPACE,
            keyPrefix: childPrefix
        }
    ];
}
