import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubMessage
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';

export function createPostgresQueuePubSubBridge(
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
                    if (message === undefined) {
                        return;
                    }
                    await onMessage(message);
                }
            );
        }
    };
}

function parsePostgresPubSubMessage(payload: string): JsonWireValue | undefined {
    try {
        return decodeJsonWireValue(JSON.parse(payload), 'PostgreSQL QueueBox pub/sub message');
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
