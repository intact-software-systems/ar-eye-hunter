import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { QueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';

interface LocalQueuePubSubSubscriber {
    readonly ignoredPublisherId?: string;
    readonly onMessage: (message: JsonWireValue) => Promise<void> | void;
}

export interface LocalQueuePubSubBus {
    readonly subscribersByChannel: Map<string, Set<LocalQueuePubSubSubscriber>>;
}

export interface LocalQueuePubSubBridgeOptions {
    readonly ignoredPublisherId?: string;
    readonly bus: LocalQueuePubSubBus;
}

export function createLocalQueuePubSubBus(): LocalQueuePubSubBus {
    return {
        subscribersByChannel: new Map()
    };
}

export function createLocalQueuePubSubBridge(
    options: LocalQueuePubSubBridgeOptions
): QueueBoxPubSubBridge {
    return {
        publish: async (channel, message) => {
            const subscribers = options.bus.subscribersByChannel.get(channel);
            if (!subscribers) {
                return;
            }

            for (const subscriber of [...subscribers]) {
                if (subscriber.ignoredPublisherId === message.publisherId) {
                    continue;
                }
                await subscriber.onMessage(message);
            }
        },
        subscribe: (channel, onMessage) => {
            let subscribers = options.bus.subscribersByChannel.get(channel);
            if (!subscribers) {
                subscribers = new Set();
                options.bus.subscribersByChannel.set(channel, subscribers);
            }

            subscribers.add({
                ignoredPublisherId: options.ignoredPublisherId,
                onMessage
            });
            return Promise.resolve();
        }
    };
}

export function createDisabledQueuePubSubBridge(): QueueBoxPubSubBridge {
    return {
        publish: async () => {
        },
        subscribe: async () => {
        }
    };
}
