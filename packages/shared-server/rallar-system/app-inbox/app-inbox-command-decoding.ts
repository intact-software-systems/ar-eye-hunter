import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { requireExactOptionalKeys, requireString } from '../protocol/exact-object-decoding.ts';
import {
    decodeJsonWireText,
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../protocol/json-wire-identity.ts';
import { isAppInboxType, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';

export class AppInboxTypeUnavailableError extends TypeError {
    constructor() {
        super('AppInbox enqueue type is unavailable');
        this.name = 'AppInboxTypeUnavailableError';
    }
}

export function decodeAppInboxEnqueue(
    value: unknown
): AppInboxEnqueueInput {
    const wire = decodeJsonWireValue(value, 'AppInbox enqueue');
    const enqueue = requireAppInboxWireObject(wire, 'AppInbox enqueue');
    requireExactOptionalKeys({
        value: enqueue,
        required: ['type', 'contextId', 'data'],
        optional: ['topicId', 'resourceId', 'senderId', 'authority'],
        label: 'AppInbox enqueue'
    });
    requireString(enqueue.type, 'AppInbox enqueue type');
    if (!isAppInboxType(enqueue.type)) {
        throw new AppInboxTypeUnavailableError();
    }
    for (const field of ['topicId', 'resourceId', 'senderId'] as const) {
        if (enqueue[field] !== undefined) {
            requireString(enqueue[field], `AppInbox enqueue ${field}`);
        }
    }
    requireString(enqueue.contextId, 'AppInbox enqueue contextId');
    return {
        type: enqueue.type,
        ...(typeof enqueue.topicId === 'string' ? { topicId: enqueue.topicId } : {}),
        ...(typeof enqueue.resourceId === 'string' ? { resourceId: enqueue.resourceId } : {}),
        contextId: enqueue.contextId,
        ...(typeof enqueue.senderId === 'string' ? { senderId: enqueue.senderId } : {}),
        ...(Object.prototype.hasOwnProperty.call(enqueue, 'authority')
            ? { authority: enqueue.authority }
            : {}),
        data: enqueue.data
    };
}

function requireAppInboxWireObject(value: JsonWireValue, label: string): JsonWireObject {
    if (value === null || typeof value !== 'object' || isJsonWireArray(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonWireArray(value: JsonWireValue): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}

export function decodePersistedAppInboxEnqueue(
    entry: ResourceEntry
): AppInboxEnqueueInput {
    return decodePersistedAppInboxCommand(
        requireAppInboxWireObject(
            decodeJsonWireText(entry.resource, 'Persisted AppInbox message'),
            'Persisted AppInbox message'
        )
    );
}

export function decodePersistedAppInboxCommand(message: JsonWireObject): AppInboxEnqueueInput {
    const payload = requireAppInboxWireObject(
        message.payload,
        'Persisted AppInbox message payload'
    );
    if (typeof payload.resource !== 'string') {
        throw new TypeError('Persisted AppInbox message resource is invalid');
    }
    return decodeAppInboxEnqueue(
        decodeJsonWireText(payload.resource, 'Persisted AppInbox command')
    );
}
