import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateReadBatchSelector } from '../../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateRepositoryLike } from '../../../../runtime-state/runtime-state-repository.ts';
import { groupStateChildStorageKey } from '../aggregate/group-aggregate-storage-keys.ts';
import { toGroupStateReadBatchLiveSelections } from '../group-state-persistence-contracts.ts';
import { SUBSCRIPTIONS_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import { canonicalStoredTopicSubscriptions } from './group-topic-subscription-codec.ts';

export interface ReadGroupSessionTopicSubscriptionsInput {
    readonly ref: GroupRef;
    readonly sessionId: string;
    readonly observedAtEpochMs: number;
}

/** One session's live subscription rows in the group, in topicId order; a lapsed row is absent. */
export async function readGroupSessionTopicSubscriptions(
    repository: RuntimeStateRepositoryLike,
    input: ReadGroupSessionTopicSubscriptionsInput
): Promise<readonly GroupTopicSubscription[]> {
    const selectors: readonly RuntimeStateReadBatchSelector[] = [{
        selectorId: 'session-subscriptions',
        kind: 'prefix',
        namespace: SUBSCRIPTIONS_NAMESPACE,
        keyPrefix: `${groupStateChildStorageKey(input.ref, 'session', input.sessionId)}:`
    }];
    const [selection] = toGroupStateReadBatchLiveSelections(
        selectors,
        await repository.readRuntimeStateBatch(selectors),
        input.observedAtEpochMs
    );
    return canonicalStoredTopicSubscriptions(selection.entries, input.ref)
        .map(({ value }) => value)
        .sort((left, right) => (left.topicId < right.topicId ? -1 : left.topicId > right.topicId ? 1 : 0));
}
