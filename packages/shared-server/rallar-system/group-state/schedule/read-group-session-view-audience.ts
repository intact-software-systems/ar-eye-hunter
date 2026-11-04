import type { GroupRef } from '@shared/api/group-types.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { readViewWatchRecipients } from '../../view-watch/read-view-watch-recipients.ts';
import { groupStateScopeStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { canonicalStoredGroupSessionIntent, GROUP_SESSION_INTENTS_NAMESPACE } from './group-session-intent-storage.ts';

export interface GroupSessionViewAudience {
    readonly ref: GroupRef;
    readonly principalIds: readonly string[];
}

/** Called after the group predecessor is captured; watch and intent mutations advance that same guard. */
export async function readGroupSessionViewAudience(
    repository: RuntimeStateRepositoryLike,
    ref: GroupRef,
    nowEpochMs: number
): Promise<GroupSessionViewAudience> {
    const [selections, watchers] = await Promise.all([
        repository.readRuntimeStateBatch([{
            selectorId: 'session-intents',
            kind: 'prefix-suffix',
            namespace: GROUP_SESSION_INTENTS_NAMESPACE,
            keyPrefix: groupStateScopeStorageKey(ref) + ':principal=',
            keySuffix: ':group=' + encodeURIComponent(ref.groupId)
        }]),
        readViewWatchRecipients(repository, { ...ref, family: 'session-preview', resourceId: ref.groupId }, nowEpochMs)
    ]);
    if (selections.length !== 1 || selections[0].selectorId !== 'session-intents') {
        throw new TypeError('Session view audience returned another intent selection');
    }
    const intents = selections[0].entries.map((entry) =>
        canonicalStoredGroupSessionIntent({
            entry,
            value: decodeJsonWireValue(JSON.parse(entry.value), 'Session view intent')
        }, ref).value.principalId
    );
    return { ref, principalIds: [...new Set([...intents, ...watchers])].sort() };
}
