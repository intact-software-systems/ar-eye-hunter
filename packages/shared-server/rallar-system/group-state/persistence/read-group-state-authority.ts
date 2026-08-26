import type { GroupRef } from '@shared/api/group-types.ts';
import { resolveRuntimeStateReadBatchLiveValues } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import { type RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    GROUPS_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from './group-state-runtime-namespaces.ts';
import { groupStateGroupStorageKey } from './group-state-storage-keys.ts';

export type GroupStateAuthorityBatchRead =
    | Readonly<{ status: 'concurrent-change'; }>
    | Readonly<{
        status: 'stable';
        group: RuntimeStateEntryValue<JsonWireValue> | undefined;
        members: readonly RuntimeStateEntryValue<JsonWireValue>[];
        summary: RuntimeStateEntryValue<JsonWireValue> | undefined;
        sessions: readonly RuntimeStateEntryValue<JsonWireValue>[];
    }>;

export async function readGroupStateAuthorityBatch(
    repository: RuntimeStateRepositoryLike,
    ref: GroupRef,
    toLiveEntryValue: (
        namespace: string,
        entry: RuntimeStateEntry
    ) => Promise<RuntimeStateEntryValue<JsonWireValue> | undefined>
): Promise<GroupStateAuthorityBatchRead> {
    const groupKey = groupStateGroupStorageKey(ref);
    const childPrefix = `${groupKey}:`;
    const selectors: readonly RuntimeStateReadBatchSelector[] = [
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
    const resolved = await resolveRuntimeStateReadBatchLiveValues(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        toLiveEntryValue
    );
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
