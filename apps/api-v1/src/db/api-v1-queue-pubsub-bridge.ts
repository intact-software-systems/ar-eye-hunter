import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubDelivery
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';
import { createPostgresQueuePubSubBridge } from './create-postgres-queue-pub-sub-bridge.ts';
import {
    createDisabledQueuePubSubBridge,
    createLocalQueuePubSubBridge,
    type LocalQueuePubSubBus
} from './local-queue-pubsub-bridge.ts';

export interface CreateApiV1QueuePubSubBridgeInput {
    readonly mode: ApiV1DatabaseConfiguration['pubSub'];
    readonly publisherId: string;
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly localBus: LocalQueuePubSubBus;
}

export function createApiV1QueuePubSubBridge(
    input: CreateApiV1QueuePubSubBridgeInput
): QueueBoxPubSubBridge {
    switch (input.mode) {
        case 'postgres':
            if (input.notification === null) {
                throw new TypeError('PostgreSQL pub/sub requires the database notification port.');
            }
            return createPostgresQueuePubSubBridge(input.notification);
        case 'local':
            return createLocalQueuePubSubBridge({
                ignoredPublisherId: input.publisherId,
                bus: input.localBus
            });
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
