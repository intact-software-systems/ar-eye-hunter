import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubDelivery
} from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';
import { createDisabledQueuePubSubBridge, createLocalQueuePubSubBridge } from './local-queue-pubsub-bridge.ts';
import { createPostgresQueuePubSubBridge } from './postgres-queue-pubsub-bridge.ts';

export function createApiV1QueuePubSubBridge(
    mode: ApiV1DatabaseConfiguration['pubSub'],
    publisherId: string,
    notification: ApiV1DatabaseNotificationPort | null
): QueueBoxPubSubBridge {
    switch (mode) {
        case 'postgres':
            if (notification === null) {
                throw new TypeError('PostgreSQL pub/sub requires the database notification port.');
            }
            return createPostgresQueuePubSubBridge(publisherId, notification);
        case 'local':
            return createLocalQueuePubSubBridge({ ignoredPublisherId: publisherId });
        case 'disabled':
            return createDisabledQueuePubSubBridge();
    }
}

export function shouldInstallQueuePubSubBridge(
    mode: ApiV1DatabaseConfiguration['pubSub']
): boolean {
    return mode !== 'disabled';
}

export function queuePubSubDeliveryForMode(
    mode: ApiV1DatabaseConfiguration['pubSub']
): QueueBoxPubSubDelivery {
    return mode === 'postgres' ? 'key' : 'entry';
}
