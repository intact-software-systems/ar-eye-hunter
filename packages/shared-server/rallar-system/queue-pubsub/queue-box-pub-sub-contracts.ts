import { EnqueuedType } from '@shared/api/api-config.ts';
import type { JsonWireObject, JsonWireValue } from '../protocol/json-wire-identity.ts';

export interface QueueBoxPubSubMessageKey extends JsonWireObject {
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
}

export interface QueueBoxPubSubMessage extends JsonWireObject {
    readonly key: QueueBoxPubSubMessageKey;
    readonly channel: string;
    readonly publisherId: string;
    readonly typeId: typeof EnqueuedType.WS_OUTBOX;
    readonly delivery: 'key';
    readonly expiresAtMs: number;
}

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
    if (!isJsonWireObject(message) || new TextEncoder().encode(JSON.stringify(message)).length >= 8_000) {
        return undefined;
    }
    const key = decodeQueueBoxPubSubMessageKey(message.key);
    if (
        message.channel !== expectedChannel ||
        !isNonEmptyString(message.publisherId) ||
        message.typeId !== EnqueuedType.WS_OUTBOX ||
        message.delivery !== 'key' ||
        typeof message.expiresAtMs !== 'number' || !Number.isSafeInteger(message.expiresAtMs) ||
        message.expiresAtMs < 0 ||
        !hasExactKeys(message, ['key', 'channel', 'publisherId', 'typeId', 'delivery', 'expiresAtMs']) ||
        !key
    ) {
        return undefined;
    }
    return {
        key,
        channel: message.channel,
        publisherId: message.publisherId,
        typeId: message.typeId,
        delivery: 'key',
        expiresAtMs: message.expiresAtMs
    };
}

function decodeQueueBoxPubSubMessageKey(
    key: JsonWireValue
): QueueBoxPubSubMessageKey | undefined {
    if (
        !isJsonWireObject(key) ||
        !hasExactKeys(key, ['topicId', 'resourceId', 'contextId']) ||
        !isNonEmptyString(key.topicId, 36) ||
        !isNonEmptyString(key.resourceId, 128) ||
        !isNonEmptyString(key.contextId, 128)
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

function isNonEmptyString(value: JsonWireValue, maxLength = 8_000): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
