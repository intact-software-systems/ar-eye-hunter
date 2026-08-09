export type QueueBoxPubSubMessageKey = Readonly<{
    topicId: string;
    resourceId: string;
    contextId: string;
}>;

export type QueueBoxPubSubDelivery = 'entry' | 'key';

type QueueBoxPubSubMessageBase = Readonly<{
    key: QueueBoxPubSubMessageKey;
    channel: string;
    publisherId: string;
    typeId: string;
}>;

export type QueueBoxPubSubEntryMessage = QueueBoxPubSubMessageBase & Readonly<{
    delivery?: 'entry';
    payload: string;
}>;

export type QueueBoxPubSubKeyMessage = QueueBoxPubSubMessageBase & Readonly<{
    delivery: 'key';
    payload?: undefined;
}>;

export type QueueBoxPubSubMessage =
    | QueueBoxPubSubEntryMessage
    | QueueBoxPubSubKeyMessage;

export type QueueBoxPubSubBridge = Readonly<{
    publish(channel: string, message: QueueBoxPubSubMessage): Promise<void>;
    subscribe(
        channel: string,
        onMessage: (message: QueueBoxPubSubMessage) => Promise<void> | void,
    ): Promise<void>;
}>;

export function isValidQueueBoxPubSubMessage(
    message: QueueBoxPubSubMessage,
    expectedChannel: string,
): boolean {
    if (!message || typeof message !== 'object') {
        return false;
    }
    if (message.channel !== expectedChannel) {
        return false;
    }
    if (
        typeof message.publisherId !== 'string' ||
        typeof message.typeId !== 'string' ||
        !isValidQueueBoxPubSubMessageKey(message.key)
    ) {
        return false;
    }
    if (message.delivery === 'key') {
        return message.payload === undefined;
    }

    return (message.delivery === undefined || message.delivery === 'entry') &&
        typeof message.payload === 'string';
}

function isValidQueueBoxPubSubMessageKey(
    key: QueueBoxPubSubMessageKey | undefined,
): key is QueueBoxPubSubMessageKey {
    return !!key &&
        typeof key.topicId === 'string' &&
        typeof key.resourceId === 'string' &&
        typeof key.contextId === 'string';
}
