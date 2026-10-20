import type { GroupRef } from '@shared/api/group-types.ts';
import { resolveRuntimeStateReadBatchLiveValues } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector,
    RuntimeStateReadBatchVersion,
    RuntimeStateReadBatchVersionReader
} from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { groupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';
import {
    GROUPS_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_ADMISSIONS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';

export type GroupStateAuthorityBatchRead =
    | Readonly<{ status: 'concurrent-change'; }>
    | Readonly<{
        status: 'stable';
        group: RuntimeStateEntryValue<JsonWireValue> | undefined;
        members: readonly RuntimeStateEntryValue<JsonWireValue>[];
        summary: RuntimeStateEntryValue<JsonWireValue> | undefined;
        sessions: readonly RuntimeStateEntryValue<JsonWireValue>[];
    }>;

type GroupStateLiveEntryValue = (
    namespace: string,
    entry: RuntimeStateEntry
) => Promise<RuntimeStateEntryValue<JsonWireValue> | undefined>;

export interface VersionedGroupStateAuthorityBatchRead {
    readonly read: GroupStateAuthorityBatchRead;
    /** The version of the rows the read came from; undefined when it found none. */
    readonly version: RuntimeStateReadBatchVersion | undefined;
}

export async function readGroupStateAuthorityBatch(
    repository: RuntimeStateRepositoryLike,
    ref: GroupRef,
    toLiveEntryValue: GroupStateLiveEntryValue
): Promise<GroupStateAuthorityBatchRead> {
    const selectors = toGroupStateAuthoritySelectors(ref);
    return await toGroupStateAuthorityBatchRead(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        toLiveEntryValue
    );
}

/** The same batch read with the version of exactly the rows it returned, from one statement (D289). */
export async function readVersionedGroupStateAuthorityBatch(
    reader: RuntimeStateReadBatchVersionReader,
    ref: GroupRef,
    toLiveEntryValue: GroupStateLiveEntryValue
): Promise<VersionedGroupStateAuthorityBatchRead> {
    const selectors = toGroupStateAuthoritySelectors(ref);
    const batch = await reader.readRuntimeStateBatchWithVersion(selectors);
    return {
        read: await toGroupStateAuthorityBatchRead(selectors, batch.selections, toLiveEntryValue),
        version: batch.version
    };
}

async function toGroupStateAuthorityBatchRead(
    selectors: readonly RuntimeStateReadBatchSelector[],
    selections: readonly RuntimeStateReadBatchSelection[],
    toLiveEntryValue: GroupStateLiveEntryValue
): Promise<GroupStateAuthorityBatchRead> {
    const resolved = await resolveRuntimeStateReadBatchLiveValues(selectors, selections, toLiveEntryValue);
    if (resolved.status === 'changed') {
        return { status: 'concurrent-change' };
    }
    const [group, members, summary, sessions] = resolved.selections;
    return {
        status: 'stable',
        group: group.entries[0],
        members: members.entries,
        summary: summary.entries[0],
        sessions: sessions.entries
    };
}

/** The version of exactly the rows `readGroupStateAuthorityBatch` reads for each group, without their values, in one read (D289). */
export async function readGroupStateAuthorityVersions(
    reader: RuntimeStateReadBatchVersionReader,
    refs: readonly GroupRef[]
): Promise<readonly (RuntimeStateReadBatchVersion['version'] | undefined)[]> {
    return await reader.readRuntimeStateBatchVersions(refs.map(toGroupStateAuthoritySelectors));
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

function toGroupStateAuthoritySelectors(ref: GroupRef): readonly RuntimeStateReadBatchSelector[] {
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
