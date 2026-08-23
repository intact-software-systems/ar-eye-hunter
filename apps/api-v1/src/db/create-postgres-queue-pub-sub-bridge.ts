import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubMessage,
    QueueBoxPubSubMessageKey
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';

export function createPostgresQueuePubSubBridge(
    publisherId: string,
    notification: ApiV1DatabaseNotificationPort
): QueueBoxPubSubBridge {
    return {
        publish: async (channel, message) => {
            await notification.notify(channel, toKeyOnlyMessage(channel, message));
        },
        subscribe: async (channel, onMessage) => {
            await notification.listen(
                channel,
                async (payload) => {
                    const message = parsePostgresPubSubMessage(payload);
                    if (
                        !isValidPostgresPubSubMessage(message, channel) ||
                        message.publisherId === publisherId
                    ) {
                        return;
                    }
                    await onMessage(message);
                }
            );
        }
    };
}

function parsePostgresPubSubMessage(payload: string): QueueBoxPubSubMessage | undefined {
    try {
        return JSON.parse(payload) as QueueBoxPubSubMessage;
    }
    catch {
        return undefined;
    }
}

function toKeyOnlyMessage(
    channel: string,
    message: QueueBoxPubSubMessage
): QueueBoxPubSubMessage {
    return {
        key: message.key,
        channel,
        publisherId: message.publisherId,
        typeId: message.typeId,
        delivery: 'key'
    };
}

function isValidPostgresPubSubMessage(
    value: QueueBoxPubSubMessage | undefined,
    channel: string
): value is QueueBoxPubSubMessage {
    if (!value || typeof value !== 'object') {
        return false;
    }

    return value.channel === channel &&
        typeof value.publisherId === 'string' &&
        typeof value.typeId === 'string' &&
        isValidMessageKey(value.key) &&
        (
            value.delivery === 'key'
                ? value.payload === undefined
                : typeof value.payload === 'string'
        );
}

function isValidMessageKey(
    key: QueueBoxPubSubMessageKey | undefined
): key is QueueBoxPubSubMessageKey {
    return !!key &&
        typeof key.topicId === 'string' &&
        typeof key.resourceId === 'string' &&
        typeof key.contextId === 'string';
}
