import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { requireExactOptionalKeys, requireString } from '../protocol/exact-object-decoding.ts';
import {
    decodeJsonWireText,
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../protocol/json-wire-identity.ts';
import { AppInboxType, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';

const APP_INBOX_TYPES = new Set<string>(Object.values(AppInboxType));

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
        required: ['type', 'data'],
        optional: ['topicId', 'resourceId', 'contextId', 'senderId', 'authority'],
        label: 'AppInbox enqueue'
    });
    requireString(enqueue.type, 'AppInbox enqueue type');
    if (!APP_INBOX_TYPES.has(enqueue.type)) {
        throw new AppInboxTypeUnavailableError();
    }
    for (const field of ['topicId', 'resourceId', 'contextId', 'senderId'] as const) {
        if (enqueue[field] !== undefined) {
            requireString(enqueue[field], `AppInbox enqueue ${field}`);
        }
    }
    return {
        type: enqueue.type as AppInboxType,
        ...(typeof enqueue.topicId === 'string' ? { topicId: enqueue.topicId } : {}),
        ...(typeof enqueue.resourceId === 'string' ? { resourceId: enqueue.resourceId } : {}),
        ...(typeof enqueue.contextId === 'string' ? { contextId: enqueue.contextId } : {}),
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
    const message = requireAppInboxWireObject(
        decodeJsonWireText(entry.resource, 'Persisted AppInbox message'),
        'Persisted AppInbox message'
    );
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
