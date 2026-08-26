import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { requireExactOptionalKeys, requireRecord, requireString } from '../protocol/exact-object-decoding.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../protocol/json-wire-identity.ts';
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
): AppInboxEnqueueInput<JsonWireValue> {
    const wire = decodeJsonWireValue(value, 'AppInbox enqueue');
    const enqueue = requireRecord(wire, 'AppInbox enqueue');
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
            ? {
                authority: decodeJsonWireValue(
                    enqueue.authority,
                    'AppInbox enqueue authority'
                )
            }
            : {}),
        data: decodeJsonWireValue(enqueue.data, 'AppInbox enqueue data')
    };
}

export function decodePersistedAppInboxEnqueue(
    entry: ResourceEntry
): AppInboxEnqueueInput<JsonWireValue> {
    const message = requireRecord(JSON.parse(entry.resource), 'Persisted AppInbox message');
    const payload = requireRecord(message.payload, 'Persisted AppInbox message payload');
    if (typeof payload.resource !== 'string') {
        throw new TypeError('Persisted AppInbox message resource is invalid');
    }
    return decodeAppInboxEnqueue(JSON.parse(payload.resource));
}
