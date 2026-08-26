import type { JsonWireObject, JsonWireValue } from '../protocol/json-wire-identity.ts';

export interface QueueBoxPubSubMessageKey extends JsonWireObject {
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
}

export type QueueBoxPubSubDelivery = 'entry' | 'key';

interface QueueBoxPubSubMessageBase extends JsonWireObject {
    readonly key: QueueBoxPubSubMessageKey;
    readonly channel: string;
    readonly publisherId: string;
    readonly typeId: string;
}

export interface QueueBoxPubSubEntryMessage extends QueueBoxPubSubMessageBase {
    readonly delivery: 'entry';
    readonly payload: string;
}

export interface QueueBoxPubSubKeyMessage extends QueueBoxPubSubMessageBase {
    readonly delivery: 'key';
}

export type QueueBoxPubSubMessage =
    | QueueBoxPubSubEntryMessage
    | QueueBoxPubSubKeyMessage;

export interface QueueBoxPubSubBridge {
    publish(channel: string, message: QueueBoxPubSubMessage): Promise<void>;
    subscribe(
        channel: string,
        onMessage: (message: JsonWireValue) => Promise<void> | void
    ): Promise<void>;
}

export function decodeQueueBoxPubSubMessage(
    message: JsonWireValue,
    expectedChannel: string
): QueueBoxPubSubMessage | undefined {
    if (!isJsonWireObject(message)) {
        return undefined;
    }
    const key = decodeQueueBoxPubSubMessageKey(message.key);
    if (
        message.channel !== expectedChannel ||
        !isNonEmptyString(message.publisherId) ||
        !isNonEmptyString(message.typeId) ||
        !key
    ) {
        return undefined;
    }
    if (message.delivery === 'key') {
        return hasExactKeys(message, ['key', 'channel', 'publisherId', 'typeId', 'delivery'])
            ? {
                key,
                channel: message.channel,
                publisherId: message.publisherId,
                typeId: message.typeId,
                delivery: 'key'
            }
            : undefined;
    }
    return message.delivery === 'entry' &&
            isNonEmptyString(message.payload) &&
            hasExactKeys(message, ['key', 'channel', 'publisherId', 'typeId', 'delivery', 'payload'])
        ? {
            key,
            channel: message.channel,
            publisherId: message.publisherId,
            typeId: message.typeId,
            delivery: 'entry',
            payload: message.payload
        }
        : undefined;
}

function decodeQueueBoxPubSubMessageKey(
    key: JsonWireValue
): QueueBoxPubSubMessageKey | undefined {
    if (
        !isJsonWireObject(key) ||
        !hasExactKeys(key, ['topicId', 'resourceId', 'contextId']) ||
        !isNonEmptyString(key.topicId) ||
        !isNonEmptyString(key.resourceId) ||
        !isNonEmptyString(key.contextId)
    ) {
        return undefined;
    }
    return {
        topicId: key.topicId,
        resourceId: key.resourceId,
        contextId: key.contextId
    };
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
    value: JsonWireObject,
    expected: readonly string[]
): boolean {
    const actual = Object.keys(value).toSorted();
    const sortedExpected = expected.toSorted();
    return actual.length === expected.length &&
        actual.every((key, index) => key === sortedExpected[index]);
}

function isNonEmptyString(value: JsonWireValue): value is string {
    return typeof value === 'string' && value.length > 0;
}
