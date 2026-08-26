import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { toAppQueueCreatedBy, toAppQueueKey, toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import type { AppInboxEnqueueInput } from './app-inbox-contracts.ts';

export function toAppInboxResourceEntry(
    enqueue: AppInboxEnqueueInput,
    serviceId: string
): ResourceEntry {
    const key = toPhysicalAppInboxQueueKey(
        {
            ...enqueue,
            topicId: enqueue.topicId ?? '',
            resourceId: enqueue.resourceId ?? '',
            contextId: enqueue.contextId ?? ''
        },
        '',
        true
    );
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALUntargetedMessage(
            toAppQueueCreatedBy(serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            enqueue.type,
            enqueue
        ),
        'APP_INBOX'
    );
}

export function toPhysicalAppInboxQueueKey(
    enqueue: AppInboxEnqueueInput,
    defaultTopicId = '',
    strictQueueIdentity = false
): Key {
    const key = {
        topicId: enqueue.topicId ?? defaultTopicId,
        resourceId: enqueue.resourceId ?? crypto.randomUUID().toString(),
        contextId: enqueue.contextId ?? enqueue.senderId ?? 'rallar-server'
    };
    return strictQueueIdentity ? toStrictAppInboxQueueKey(key) : toAppQueueKey(key);
}
