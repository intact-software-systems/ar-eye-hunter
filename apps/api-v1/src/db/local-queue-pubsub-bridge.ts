import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubMessage
} from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';

type LocalQueuePubSubSubscriber = Readonly<{
    ignoredPublisherId?: string;
    onMessage: (message: QueueBoxPubSubMessage) => Promise<void> | void;
}>;

export type LocalQueuePubSubBus = Readonly<{
    subscribersByChannel: Map<string, Set<LocalQueuePubSubSubscriber>>;
}>;

export type LocalQueuePubSubBridgeOptions = Readonly<{
    ignoredPublisherId?: string;
    bus?: LocalQueuePubSubBus;
}>;

const defaultBus = createLocalQueuePubSubBus();

export function createLocalQueuePubSubBus(): LocalQueuePubSubBus {
    return {
        subscribersByChannel: new Map()
    };
}

export function createLocalQueuePubSubBridge(
    options: LocalQueuePubSubBridgeOptions = {}
): QueueBoxPubSubBridge {
    const bus = options.bus ?? defaultBus;

    return {
        publish: async (channel, message) => {
            const subscribers = bus.subscribersByChannel.get(channel);
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
            let subscribers = bus.subscribersByChannel.get(channel);
            if (!subscribers) {
                subscribers = new Set();
                bus.subscribersByChannel.set(channel, subscribers);
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
