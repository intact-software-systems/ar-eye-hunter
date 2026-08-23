import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { serializeCanonicalMutationCommand, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from './app-inbox-contracts.ts';

/** Reads the current nested QueueBox/AppInbox wire shape. */
export function readPersistedAppInboxEnqueue(
    entry: ResourceEntry
): AppInboxEnqueueInput<unknown> {
    const message = JSON.parse(entry.resource) as ALMessage;
    if (
        message === null ||
        typeof message !== 'object' ||
        message.payload === null ||
        typeof message.payload !== 'object' ||
        typeof message.payload.resource !== 'string'
    ) {
        throw new TypeError('Invalid persisted AppInbox message');
    }
    const enqueue = JSON.parse(message.payload.resource) as unknown;
    if (
        enqueue === null ||
        typeof enqueue !== 'object' ||
        Array.isArray(enqueue) ||
        typeof (enqueue as Record<string, unknown>).type !== 'string' ||
        !Object.prototype.hasOwnProperty.call(enqueue, 'data')
    ) {
        throw new TypeError('Invalid persisted AppInbox enqueue');
    }
    return toJsonWireAppInboxEnqueue(enqueue as AppInboxEnqueueInput<unknown>);
}

export function toJsonWireAppInboxEnqueue<V>(
    enqueue: AppInboxEnqueueInput<V>
): AppInboxEnqueueInput<V> {
    return toJsonWireValue(enqueue, '$', new Set()) as AppInboxEnqueueInput<V>;
}

export function serializeCanonicalJsonWire(value: unknown): string {
    return serializeCanonicalMutationCommand(value as JsonWireValue);
}

function toJsonWireValue(value: unknown, path: string, ancestors: Set<object>): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            rejectJsonWire(path, 'contains a non-finite number');
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') {
        rejectJsonWire(path, `contains unsupported ${typeof value}`);
    }
    if (ancestors.has(value)) {
        rejectJsonWire(path, 'contains a cycle');
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return toJsonWireArray(value, path, ancestors);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            rejectJsonWire(path, 'must contain only plain JSON objects');
        }
        const result = Object.create(null) as Record<string, unknown>;
        for (const key of Reflect.ownKeys(Object.getOwnPropertyDescriptors(value))) {
            if (typeof key === 'symbol') {
                rejectJsonWire(path, 'contains a symbol key');
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!descriptor.enumerable) {
                continue;
            }
            if (!('value' in descriptor)) {
                rejectJsonWire(`${path}.${key}`, 'contains an accessor');
            }
            if (descriptor.value !== undefined) {
                result[key] = toJsonWireValue(descriptor.value, `${path}.${key}`, ancestors);
            }
        }
        return result;
    }
    finally {
        ancestors.delete(value);
    }
}

function toJsonWireArray(value: unknown[], path: string, ancestors: Set<object>): unknown[] {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) {
            rejectJsonWire(`${path}[${index}]`, 'must be a dense data element');
        }
        if (
            descriptor.value === undefined ||
            ['function', 'symbol', 'bigint'].includes(typeof descriptor.value)
        ) {
            rejectJsonWire(`${path}[${index}]`, 'contains an unsupported array value');
        }
        result.push(toJsonWireValue(descriptor.value, `${path}[${index}]`, ancestors));
    }
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') {
            rejectJsonWire(path, 'contains a symbol key');
        }
        if (key === 'length' || /^(0|[1-9]\d*)$/u.test(key)) {
            continue;
        }
        if (descriptors[key]?.enumerable) {
            rejectJsonWire(path, `contains unsupported array property ${key}`);
        }
    }
    return result;
}

function rejectJsonWire(path: string, detail: string): never {
    throw new TypeError(`App inbox JSON wire ${path} ${detail}`);
}
