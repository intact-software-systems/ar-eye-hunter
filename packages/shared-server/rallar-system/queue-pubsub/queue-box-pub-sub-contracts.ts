import { decodePersistedALMessageRow } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { computeUtf8ByteLength } from '@shared/encoding/compute-utf8-byte-length.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { JsonWireObject, JsonWireValue } from '../protocol/json-wire-identity.ts';

/** A notice this large or larger is malformed; a publisher sheds its carried drops to stay under it. */
export const QUEUE_BOX_PUB_SUB_NOTICE_MAX_BYTES = 8_000;

export interface QueueBoxPubSubMessageKey extends JsonWireObject {
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
}

/** An intersection, not an interface extending the wire object, whose index signature refuses an optional field. */
export type QueueBoxPubSubMessage = JsonWireObject & {
    readonly key: QueueBoxPubSubMessageKey;
    readonly channel: string;
    readonly publisherId: string;
    readonly typeId: typeof EnqueuedType.WS_OUTBOX;
    readonly delivery: 'key';
    readonly expiresAtMs: number;
    /**
     * The captured sessions the publishing attempt's dequeue dropped; absent, the notice carries no judgement and its
     * receiver re-checks.
     */
    readonly droppedSessionIds?: readonly string[];
};

export interface QueueBoxPubSubBridge {
    publish(channel: string, message: QueueBoxPubSubMessage): Promise<void>;
    subscribe(
        channel: string,
        onMessage: (message: JsonWireValue) => Promise<void> | void,
        onSubscribed?: () => void
    ): Promise<void>;
}

export function decodeQueueBoxPubSubMessage(
    message: JsonWireValue,
    expectedChannel: string
): QueueBoxPubSubMessage | undefined {
    if (
        !isJsonWireObject(message) ||
        computeUtf8ByteLength(JSON.stringify(message)) >= QUEUE_BOX_PUB_SUB_NOTICE_MAX_BYTES
    ) {
        return undefined;
    }
    const key = decodeQueueBoxPubSubMessageKey(message.key);
    const droppedSessionIds = decodeQueueBoxPubSubDroppedSessionIds(message.droppedSessionIds);
    if (
        message.channel !== expectedChannel ||
        !isNonEmptyString(message.publisherId) ||
        message.typeId !== EnqueuedType.WS_OUTBOX ||
        message.delivery !== 'key' ||
        typeof message.expiresAtMs !== 'number' || !Number.isSafeInteger(message.expiresAtMs) ||
        message.expiresAtMs < 0 ||
        !hasExactKeys(message, [
            'key',
            'channel',
            'publisherId',
            'typeId',
            'delivery',
            'expiresAtMs',
            ...(message.droppedSessionIds === undefined ? [] : ['droppedSessionIds'])
        ]) ||
        !key || droppedSessionIds === 'malformed'
    ) {
        return undefined;
    }
    return {
        key,
        channel: message.channel,
        publisherId: message.publisherId,
        typeId: message.typeId,
        delivery: 'key',
        expiresAtMs: message.expiresAtMs,
        ...(droppedSessionIds === undefined ? {} : { droppedSessionIds })
    };
}

/** Absent carries no judgement; anything but unique non-empty session ids of at most 128 characters is malformed. */
function decodeQueueBoxPubSubDroppedSessionIds(
    droppedSessionIds: JsonWireValue | undefined
): readonly string[] | undefined | 'malformed' {
    if (droppedSessionIds === undefined) {
        return undefined;
    }
    return isQueueBoxPubSubDroppedSessionIds(droppedSessionIds) ? droppedSessionIds : 'malformed';
}

function isQueueBoxPubSubDroppedSessionIds(value: JsonWireValue): value is readonly string[] {
    return Array.isArray(value) &&
        value.every((sessionId: JsonWireValue) => isNonEmptyString(sessionId, 128)) &&
        new Set(value).size === value.length;
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

export interface ToPubSubMessageInput {
    readonly channel: string;
    readonly publisherId: string;
    readonly entry: ResourceEntry;
    readonly droppedSessionIds: readonly string[] | undefined;
}

/**
 * The notice carries the publishing attempt's drops while the decoder accepts them, under the notice cap; one whose
 * drops it would refuse carries none, and its receiver re-checks.
 */
export function toPubSubMessage(input: ToPubSubMessageInput): QueueBoxPubSubMessage {
    const { channel, publisherId, entry, droppedSessionIds } = input;
    if (entry.typeId !== EnqueuedType.WS_OUTBOX) {
        throw new TypeError('QueueBox cluster notifications require admitted WS outbox work');
    }

    const message = decodePersistedALMessageRow(entry);
    const expiresAtMs = resolveALMessageExpireAtMs(message);
    if (
        expiresAtMs === undefined || !Number.isSafeInteger(expiresAtMs) ||
        expiresAtMs > entry.audit.expiryTs.epochMilliseconds
    ) {
        throw new TypeError('Cluster notification requires a canonical logical deadline');
    }
    const unjudged: QueueBoxPubSubMessage = {
        key: entry.key,
        channel,
        publisherId,
        typeId: entry.typeId,
        delivery: 'key',
        expiresAtMs
    };
    if (droppedSessionIds !== undefined) {
        const judged = { ...unjudged, droppedSessionIds };
        if (decodeQueueBoxPubSubMessage(judged, channel)) {
            return judged;
        }
    }
    if (!decodeQueueBoxPubSubMessage(unjudged, channel)) {
        throw new TypeError('QueueBox notification exceeds physical key or wire bounds');
    }
    return unjudged;
}
