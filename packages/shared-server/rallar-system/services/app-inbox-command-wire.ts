import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { readCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { validateRtcRttMeasurement } from '../rtc-rtt-persistence-validation.ts';
import { hashCanonicalCommand } from './canonical-command-hash.ts';
import {
    AppInboxIdempotencyConflictError,
    type AppInboxEnqueueInput,
    AppInboxType,
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
        const receivedCommandHash = await hashCanonicalCommand(
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
        hashCanonicalCommand(toLogicalAppInboxCommand(normalizedExisting)),
        hashCanonicalCommand(toLogicalAppInboxCommand(incoming)),
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
    const stable = toStableTopologyCommand(enqueue.type, enqueue.data);
    if (stable) {
        return {
            type: enqueue.type,
            authority: null,
            data: stable,
        };
    }
    return {
        type: enqueue.type,
        authority: enqueue.authority ?? null,
        data: enqueue.data,
    };
}

function toStableTopologyCommand(
    type: AppInboxType,
    value: unknown,
): unknown | undefined {
    try {
        if (type === AppInboxType.RTC_RTT_SUBMIT) {
            const command = requireExactRecord(value, [
                'actor',
                'requestId',
                'commandHash',
                'mutationCommandHash',
                'capturedAtEpochMs',
                'rtt',
            ]);
            const actor = readActor(command.actor);
            readNonEmptyString(command.requestId);
            readNonEmptyString(command.commandHash);
            readNonEmptyString(command.mutationCommandHash);
            readEpoch(command.capturedAtEpochMs);
            validateRtcRttMeasurement(command.rtt);
            return {
                actor,
                requestId: command.requestId,
                commandHash: command.commandHash,
                mutationCommandHash: command.mutationCommandHash,
                rtt: command.rtt,
            };
        }
        if (!TOPOLOGY_APP_INBOX_TYPES.has(type)) return undefined;
        const command = requireExactRecord(value, [
            'actor',
            'groupRef',
            'requestId',
            'commandHash',
            'capturedAtEpochMs',
            'operation',
            'payload',
        ]);
        const actor = readActor(command.actor);
        const groupRef = requireExactRecord(command.groupRef, [
            'applicationId',
            'workspaceId',
            'groupId',
        ]);
        readNonEmptyString(groupRef.applicationId);
        readNonEmptyString(groupRef.workspaceId);
        readNonEmptyString(groupRef.groupId);
        readNonEmptyString(command.requestId);
        readNonEmptyString(command.commandHash);
        readEpoch(command.capturedAtEpochMs);
        const payload = readTopologyPayload(command.payload);
        if (command.operation !== payload.operation) {
            throw new TypeError('Topology operation differs from payload');
        }
        return {
            actor,
            groupRef,
            requestId: command.requestId,
            commandHash: command.commandHash,
            operation: command.operation,
            payload,
        };
    } catch {
        return undefined;
    }
}

const TOPOLOGY_APP_INBOX_TYPES = new Set<AppInboxType>([
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE,
]);

function readTopologyPayload(value: unknown): Record<string, unknown> {
    const record = requireRecord(value);
    switch (record.operation) {
        case 'putConfig':
            requireExactKeys(record, ['operation', 'config']);
            readCanonicalGroupTopologyConfigPatch(record.config);
            return record;
        case 'deleteConfig':
            requireExactKeys(record, ['operation', 'target']);
            if (record.target !== 'config') throw new TypeError('Invalid target');
            return record;
        case 'putOverride':
            requireExactKeys(record, [
                'operation',
                'config',
                'ttlMs',
                'expiresAtEpochMs',
            ]);
            readCanonicalGroupTopologyConfigPatch(record.config);
            readFiniteNumberOrNull(record.ttlMs);
            readFiniteNumberOrNull(record.expiresAtEpochMs);
            return record;
        case 'deleteOverride':
            requireExactKeys(record, ['operation', 'target']);
            if (record.target !== 'override') throw new TypeError('Invalid target');
            return record;
        case 'reconfigureTopology':
            requireExactKeys(record, [
                'operation',
                'requestOptions',
                'publish',
            ]);
            readCanonicalGroupTopologyConfigPatch(record.requestOptions);
            if (typeof record.publish !== 'boolean') {
                throw new TypeError('Invalid publish flag');
            }
            return record;
        default:
            throw new TypeError('Invalid topology operation');
    }
}

function readActor(value: unknown): Record<string, unknown> {
    const actor = requireExactRecord(value, ['principalId', 'sessionId']);
    readNonEmptyString(actor.principalId);
    readNonEmptyString(actor.sessionId);
    return actor;
}

function requireExactRecord(
    value: unknown,
    expected: readonly string[],
): Record<string, unknown> {
    const record = requireRecord(value);
    requireExactKeys(record, expected);
    return record;
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Expected record');
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(
    record: Record<string, unknown>,
    expected: readonly string[],
): void {
    if (
        JSON.stringify(Object.keys(record).toSorted()) !==
            JSON.stringify([...expected].toSorted())
    ) {
        throw new TypeError('Unexpected durable command fields');
    }
}

function readNonEmptyString(value: unknown): void {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('Expected non-empty string');
    }
}

function readEpoch(value: unknown): void {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError('Expected epoch');
    }
}

function readFiniteNumberOrNull(value: unknown): void {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new TypeError('Expected finite number or null');
    }
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
