import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    decodeQueueBoxPubSubMessage,
    type QueueBoxPubSubBridge
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';

export function createPostgresQueuePubSubBridge(
    notification: ApiV1DatabaseNotificationPort
): QueueBoxPubSubBridge {
    return {
        publish: async (channel, message) => {
            const notice = decodeQueueBoxPubSubMessage(message, channel);
            if (!notice) {
                throw new TypeError('PostgreSQL QueueBox notification is invalid or exceeds its wire budget');
            }
            await notification.notify(channel, notice);
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
    if (new TextEncoder().encode(payload).length >= 8_000) {
        return undefined;
    }
    try {
        return decodeJsonWireValue(JSON.parse(payload), 'PostgreSQL QueueBox pub/sub message');
    }
    catch {
        return undefined;
    }
}
