import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import {
    toAppQueueCreatedBy as toAppInboxQueueCreatedBy,
    toAppQueueKey as toAppInboxQueueKey,
    toStrictAppInboxQueueKey
} from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { toJsonWireAppInboxEnqueue } from './app-inbox-command-wire.ts';
import type { AppInboxEnqueueInput } from './app-inbox-contracts.ts';

export function toAppInboxResourceEntry<Command>(
    enqueue: AppInboxEnqueueInput<Command>,
    serviceId: string
): ResourceEntry {
    const wire = toJsonWireAppInboxEnqueue(enqueue);
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
            toAppInboxQueueCreatedBy(serviceId),
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
    return strictQueueIdentity ? toStrictAppInboxQueueKey(key) : toAppInboxQueueKey(key);
}
