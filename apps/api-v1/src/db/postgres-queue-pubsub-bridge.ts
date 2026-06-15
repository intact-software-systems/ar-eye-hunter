import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubMessageKey,
    QueueBoxPubSubMessage,
} from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import * as dbListen from './db-listen.ts';
import * as dbNotify from './db-notify.ts';

export type PostgresQueuePubSubBridgeDependencies = Readonly<{
    notify(
        channel: string,
        message: QueueBoxPubSubMessage,
    ): Promise<void>;
    startListening(
        channel: string,
        options: Readonly<{
            publisherId: string;
            onMessage: (payload: QueueBoxPubSubMessage) => void | Promise<void>;
        }>,
    ): Promise<void>;
}>;

export function createPostgresQueuePubSubBridge(
    publisherId: string,
    dependencies: PostgresQueuePubSubBridgeDependencies = {
        notify: dbNotify.notify,
        startListening: dbListen.startListening,
    },
): QueueBoxPubSubBridge {
    return {
        publish: async (channel, message) => {
            await dependencies.notify(channel, toKeyOnlyMessage(channel, message));
        },
        subscribe: async (channel, onMessage) => {
            await dependencies.startListening(channel, {
                publisherId,
                onMessage: async (message: QueueBoxPubSubMessage) => {
                    if (!isValidPostgresPubSubMessage(message, channel)) {
                        return;
                    }

                    await onMessage(message);
                },
            });
        },
    };
}

function toKeyOnlyMessage(
    channel: string,
    message: QueueBoxPubSubMessage,
): QueueBoxPubSubMessage {
    return {
        key: message.key,
        channel,
        publisherId: message.publisherId,
        typeId: message.typeId,
        delivery: 'key',
    };
}

function isValidPostgresPubSubMessage(
    message: QueueBoxPubSubMessage,
    channel: string,
): boolean {
    if (!message || typeof message !== 'object') {
        return false;
    }

    return message.channel === channel &&
        typeof message.publisherId === 'string' &&
        typeof message.typeId === 'string' &&
        isValidMessageKey(message.key) &&
        (
            message.delivery === 'key'
                ? message.payload === undefined
                : typeof message.payload === 'string'
        );
}

function isValidMessageKey(
    key: QueueBoxPubSubMessageKey | undefined,
): key is QueueBoxPubSubMessageKey {
    return !!key &&
        typeof key.topicId === 'string' &&
        typeof key.resourceId === 'string' &&
        typeof key.contextId === 'string';
}
