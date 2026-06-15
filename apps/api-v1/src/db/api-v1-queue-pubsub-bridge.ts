import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubDelivery,
} from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import type { ApiV1DatabasePubSubConfig } from './database-pubsub-config.ts';
import { createDisabledQueuePubSubBridge, createLocalQueuePubSubBridge, } from './local-queue-pubsub-bridge.ts';
import { createPostgresQueuePubSubBridge } from './postgres-queue-pubsub-bridge.ts';

export function createApiV1QueuePubSubBridge(
    config: ApiV1DatabasePubSubConfig,
    publisherId: string,
): QueueBoxPubSubBridge {
    switch (config.mode) {
        case 'postgres':
            return createPostgresQueuePubSubBridge(publisherId);
        case 'local':
            return createLocalQueuePubSubBridge({ ignoredPublisherId: publisherId });
        case 'disabled':
            return createDisabledQueuePubSubBridge();
    }
}

export function shouldInstallQueuePubSubBridge(config: ApiV1DatabasePubSubConfig): boolean {
    return config.mode !== 'disabled';
}

export function queuePubSubDeliveryForConfig(
    config: ApiV1DatabasePubSubConfig,
): QueueBoxPubSubDelivery {
    return config.mode === 'postgres' ? 'key' : 'entry';
}
