import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { toAppQueueCreatedBy, toAppQueueKey, toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { decodeAppInboxEnqueue } from './app-inbox-command-decoding.ts';
import type { AppInboxEnqueueInput } from './app-inbox-contracts.ts';

export function toAppInboxResourceEntry<Command>(
    enqueue: AppInboxEnqueueInput<Command>,
    serviceId: string
): ResourceEntry {
    const wire = decodeAppInboxEnqueue(enqueue);
    const key = toPhysicalAppInboxQueueKey(
        {
            ...wire,
            topicId: wire.topicId ?? '',
            resourceId: wire.resourceId ?? '',
            contextId: wire.contextId ?? ''
        },
        '',
        true
    );
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALUntargetedMessage(
            toAppQueueCreatedBy(serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            wire.type,
            wire
        ),
        'APP_INBOX'
    );
}

export function toPhysicalAppInboxQueueKey<Command>(
    enqueue: AppInboxEnqueueInput<Command>,
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
