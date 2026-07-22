import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { hashStateMutationCommand } from '../repositories/StateMutationOutboxRepository.ts';
import {
    AppInboxIdempotencyConflictError,
    type AppInboxEnqueueInput,
    type AppInboxType,
} from './app-inbox-contracts.ts';

export async function assertMatchingAppInboxCommand(
    entry: ResourceEntry,
    incoming: AppInboxEnqueueInput<unknown>,
    receivedCommandIdentity: string,
): Promise<void> {
    let existing: AppInboxEnqueueInput<unknown>;
    try {
        const message = JSON.parse(entry.resource) as ALMessage;
        existing = JSON.parse(message.payload.resource) as AppInboxEnqueueInput<unknown>;
    } catch {
        const receivedCommandHash = await hashStateMutationCommand(
            toLogicalAppInboxCommand(incoming),
        );
        throw new AppInboxIdempotencyConflictError(
            entry.key.resourceId,
            'invalid-existing-command',
            receivedCommandHash,
        );
    }
    const normalizedExisting = toJsonWireAppInboxEnqueue(existing);
    const existingCommandIdentity = serializeCanonicalJsonWire(
        toLogicalAppInboxCommand(normalizedExisting),
    );
    if (existingCommandIdentity === receivedCommandIdentity) return;
    const [existingCommandHash, receivedCommandHash] = await Promise.all([
        hashStateMutationCommand(toLogicalAppInboxCommand(normalizedExisting)),
        hashStateMutationCommand(toLogicalAppInboxCommand(incoming)),
    ]);
    throw new AppInboxIdempotencyConflictError(
        entry.key.resourceId,
        existingCommandHash,
        receivedCommandHash,
    );
}

export function toJsonWireAppInboxEnqueue<V>(
    enqueue: AppInboxEnqueueInput<V>,
): AppInboxEnqueueInput<V> {
    return toJsonWireValue(enqueue, '$', new Set()) as AppInboxEnqueueInput<V>;
}

export function toLogicalAppInboxCommand(enqueue: AppInboxEnqueueInput<unknown>): Readonly<{
    type: AppInboxType;
    authority: unknown;
    data: unknown;
}> {
    return {
        type: enqueue.type,
        authority: enqueue.authority ?? null,
        data: enqueue.data,
    };
}

export function serializeCanonicalJsonWire(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
    if (Array.isArray(value)) return `[${value.map(serializeCanonicalJsonWire).join(',')}]`;
    const entries = Object.keys(value)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map(key => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return `${JSON.stringify(key)}:${serializeCanonicalJsonWire(descriptor?.value)}`;
        });
    return `{${entries.join(',')}}`;
}

function toJsonWireValue(value: unknown, path: string, ancestors: Set<object>): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) rejectJsonWire(path, 'contains a non-finite number');
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') rejectJsonWire(path, `contains unsupported ${typeof value}`);
    if (ancestors.has(value)) rejectJsonWire(path, 'contains a cycle');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) return toJsonWireArray(value, path, ancestors);
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            rejectJsonWire(path, 'must contain only plain JSON objects');
        }
        const result = Object.create(null) as Record<string, unknown>;
        for (const key of Reflect.ownKeys(Object.getOwnPropertyDescriptors(value))) {
            if (typeof key === 'symbol') rejectJsonWire(path, 'contains a symbol key');
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!descriptor.enumerable) continue;
            if (!('value' in descriptor)) rejectJsonWire(`${path}.${key}`, 'contains an accessor');
            if (descriptor.value !== undefined) {
                result[key] = toJsonWireValue(descriptor.value, `${path}.${key}`, ancestors);
            }
        }
        return result;
    } finally {
        ancestors.delete(value);
    }
}

function toJsonWireArray(value: unknown[], path: string, ancestors: Set<object>): unknown[] {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) rejectJsonWire(`${path}[${index}]`, 'must be a dense data element');
        if (descriptor.value === undefined || ['function', 'symbol', 'bigint'].includes(typeof descriptor.value)) {
            rejectJsonWire(`${path}[${index}]`, 'contains an unsupported array value');
        }
        result.push(toJsonWireValue(descriptor.value, `${path}[${index}]`, ancestors));
    }
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') rejectJsonWire(path, 'contains a symbol key');
        if (key === 'length' || /^(0|[1-9]\d*)$/u.test(key)) continue;
        if (descriptors[key]?.enumerable) rejectJsonWire(path, `contains unsupported array property ${key}`);
    }
    return result;
}

function rejectJsonWire(path: string, detail: string): never {
    throw new TypeError(`App inbox JSON wire ${path} ${detail}`);
}
