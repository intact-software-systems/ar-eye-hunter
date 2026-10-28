import {
    newALRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    toAppQueueCreatedBy,
    toAppQueueKey,
    toStrictAppInboxQueueKey
} from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import type { AppInboxEnqueue, AppInboxEnqueueInput } from './app-inbox-contracts.ts';

export interface ToPhysicalAppInboxQueueKeyInput extends Pick<AppInboxEnqueue, 'topicId' | 'contextId'> {
    readonly resourceId: string;
}

export interface AppInboxQueueMessageCreationDto {
    readonly key: Key;
    readonly enqueue: AppInboxEnqueueInput;
    readonly serviceId: string;
}

/** One bounded canonical envelope construction: IDs, time and serialization; no I/O, scheduling or retry. */
export type AppInboxQueueMessageFactory = (creation: AppInboxQueueMessageCreationDto) => ALMessage;

export interface AppInboxQueueEntryCreationDependencies {
    readonly createMessage: AppInboxQueueMessageFactory;
    readonly creationNow: QueueBoxUtilities.CreationClock;
}

export function createAppInboxResourceEntry(
    enqueue: AppInboxEnqueueInput,
    serviceId: string,
    dependencies: AppInboxQueueEntryCreationDependencies
): ResourceEntry {
    const key = toPhysicalAppInboxQueueKey(
        {
            ...enqueue,
            topicId: enqueue.topicId ?? '',
            resourceId: enqueue.resourceId ?? ''
        },
        '',
        true
    );
    return QueueBoxUtilities.toResourceEntryFromMsg(
        dependencies.createMessage({ key, enqueue, serviceId }),
        'APP_INBOX',
        dependencies.creationNow()
    );
}

export function createDefaultAppInboxQueueMessage(creation: AppInboxQueueMessageCreationDto): ALMessage {
    const { traceId, ...command } = creation.enqueue;
    return newALUntargetedMessage(
        toAppQueueCreatedBy(creation.serviceId),
        newALRoute(creation.key.topicId, creation.key.contextId, creation.key.resourceId),
        command.type,
        command,
        { traceId }
    );
}

export function toPhysicalAppInboxQueueKey(
    enqueue: ToPhysicalAppInboxQueueKeyInput,
    defaultTopicId = '',
    strictQueueIdentity = false
): Key {
    const key = {
        topicId: enqueue.topicId ?? defaultTopicId,
        resourceId: enqueue.resourceId,
        contextId: enqueue.contextId
    };
    return strictQueueIdentity ? toStrictAppInboxQueueKey(key) : toAppQueueKey(key);
}
