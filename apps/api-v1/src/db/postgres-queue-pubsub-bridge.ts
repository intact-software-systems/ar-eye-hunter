import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubMessage,
} from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import * as dbListen from './db-listen.ts';
import * as dbNotify from './db-notify.ts';

export function createPostgresQueuePubSubBridge(
    publisherId: string,
): QueueBoxPubSubBridge {
    return {
        publish: async (channel, message) => {
            await dbNotify.notify(channel, message);
        },
        subscribe: async (channel, onMessage) => {
            await dbListen.startListening(channel, {
                publisherId,
                onMessage: async (message: QueueBoxPubSubMessage) => {
                    await onMessage(message);
                },
            });
        },
    };
}
