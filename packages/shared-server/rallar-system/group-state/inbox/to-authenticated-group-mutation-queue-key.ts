import { toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import type { AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-topics.ts';

/** An authenticated group command's queue identity is its request in the caller's context, reserved verbatim. */
export function toAuthenticatedGroupMutationQueueKey(
    enqueue: Pick<AppInboxEnqueueInput, 'topicId' | 'resourceId' | 'contextId'>
): Key {
    if (enqueue.resourceId === undefined) {
        throw new TypeError('An authenticated group mutation names its request as the queue resource');
    }
    return toStrictAppInboxQueueKey({
        topicId: enqueue.topicId ?? GROUP_STATE_APP_INBOX_TOPIC,
        resourceId: enqueue.resourceId,
        contextId: enqueue.contextId
    });
}
