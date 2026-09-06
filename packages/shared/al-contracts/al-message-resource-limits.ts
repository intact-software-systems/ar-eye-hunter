import {
    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    RALLAR_ROUTE_ID_MAX_LENGTH
} from '../api/rallar-validation.ts';
import { Either } from '../resilience/Either.ts';

export const AL_MESSAGE_RESOURCE_LIMITS = {
    envelopeBytes: 128 * 1024,
    payloadBytes: RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    routeIdCharacters: RALLAR_ROUTE_ID_MAX_LENGTH,
    collectionEntries: 256,
    visitedPeers: 64,
    hops: 64,
    repairWindow: 256,
    bufferedMessages: 256,
    bufferedBytes: 1024 * 1024
} as const;

/** Byte policy is selected by a trusted protocol owner, never by envelope fields. */
export interface ALMessageByteLimits {
    readonly envelopeBytes: number;
    readonly payloadBytes: number;
}

export interface ALMessageResourceIssue {
    readonly code: 'malformed' | 'oversized';
    readonly message: string;
}

interface ALMessageValue {
    readonly value: unknown;
    readonly location: ALMessageResourceLocation;
}

interface ALMessageValueSize {
    readonly bytes: number;
    readonly children: readonly ALMessageValue[];
}

type ALMessageMeasurement =
    | { readonly kind: 'value'; readonly entry: ALMessageValue; }
    | { readonly kind: 'exit'; readonly value: object; };

type ALMessageResourceLocation =
    | 'envelope'
    | 'route'
    | 'route-identifier'
    | 'payload'
    | 'payload-json'
    | 'constraints'
    | 'hop-budget'
    | 'diagnostics'
    | 'visited-peers'
    | 'other';

export function validateSerializedALMessageSize(
    serialized: string,
    byteLimits: ALMessageByteLimits = AL_MESSAGE_RESOURCE_LIMITS
): readonly ALMessageResourceIssue[] {
    if (!isValidALMessageByteLimits(byteLimits)) {
        return [{ code: 'malformed', message: 'AL envelope byte policy is invalid' }];
    }
    return exceedsUtf8Limit(serialized, byteLimits.envelopeBytes)
        ? [{ code: 'oversized', message: 'AL envelope exceeds the byte limit' }]
        : [];
}

/** Counts JSON bytes without invoking getters/toJSON or recursively visiting untrusted objects. */
export function validateALMessageResourceLimits(
    value: unknown,
    byteLimits: ALMessageByteLimits = AL_MESSAGE_RESOURCE_LIMITS
): readonly ALMessageResourceIssue[] {
    if (!isValidALMessageByteLimits(byteLimits)) {
        return [{ code: 'malformed', message: 'AL envelope byte policy is invalid' }];
    }
    try {
        const measured = computeALMessageEnvelopeSize(value, byteLimits);
        return measured.left ? [measured.left] : [];
    }
    catch {
        return [{ code: 'malformed', message: 'AL envelope cannot be inspected as plain JSON' }];
    }
}

function computeALMessageEnvelopeSize(
    value: unknown,
    byteLimits: ALMessageByteLimits
): Either<ALMessageResourceIssue, number> {
    const pending: ALMessageMeasurement[] = [{ kind: 'value', entry: { value, location: 'envelope' } }];
    const ancestors = new Set<object>();
    let bytes = 0;
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (current.kind === 'exit') {
            ancestors.delete(current.value);
            continue;
        }
        const measured = computeALMessageValueSize(current.entry, byteLimits);
        if (measured.left) {
            return Either.ofLeft(measured.left);
        }
        const size = measured.right!;
        bytes += size.bytes;
        if (bytes > byteLimits.envelopeBytes) {
            return Either.ofLeft({ code: 'oversized', message: 'AL envelope exceeds the byte limit' });
        }
        const object = current.entry.value;
        if (object !== null && typeof object === 'object') {
            if (ancestors.has(object)) {
                return Either.ofLeft({ code: 'malformed', message: 'AL envelope contains a cycle' });
            }
            ancestors.add(object);
            pending.push({ kind: 'exit', value: object });
        }
        for (const child of size.children) {
            pending.push({ kind: 'value', entry: child });
        }
    }
    return Either.ofRight(bytes);
}

function computeALMessageValueSize(
    entry: ALMessageValue,
    byteLimits: ALMessageByteLimits
): Either<ALMessageResourceIssue, ALMessageValueSize> {
    if (typeof entry.value === 'string') {
        const issues = validateALMessageString(entry.value, entry.location, byteLimits);
        if (issues.length > 0) {
            return Either.ofLeft(issues[0]);
        }
        return Either.ofRight({ bytes: new TextEncoder().encode(JSON.stringify(entry.value)).length, children: [] });
    }
    if (entry.value === null || typeof entry.value === 'boolean' || typeof entry.value === 'number') {
        if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) {
            return Either.ofLeft({ code: 'malformed', message: 'AL envelope contains a non-finite number' });
        }
        if (
            entry.location === 'hop-budget' && typeof entry.value === 'number' &&
            entry.value > AL_MESSAGE_RESOURCE_LIMITS.hops
        ) {
            return Either.ofLeft({ code: 'oversized', message: 'AL hop budget exceeds the limit' });
        }
        return Either.ofRight({ bytes: JSON.stringify(entry.value).length, children: [] });
    }
    if (entry.value === null || typeof entry.value !== 'object') {
        return Either.ofLeft({ code: 'malformed', message: 'AL envelope contains a non-JSON value' });
    }
    return computeALMessageCollectionSize(entry.value, entry.location, byteLimits);
}

function computeALMessageCollectionSize(
    value: object,
    location: ALMessageResourceLocation,
    byteLimits: ALMessageByteLimits
): Either<ALMessageResourceIssue, ALMessageValueSize> {
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
        return Either.ofLeft({ code: 'malformed', message: 'AL envelope collections must be plain JSON values' });
    }
    const limit = location === 'visited-peers'
        ? AL_MESSAGE_RESOURCE_LIMITS.visitedPeers
        : AL_MESSAGE_RESOURCE_LIMITS.collectionEntries;
    if (array && value.length > limit) {
        return Either.ofLeft({
            code: 'oversized',
            message: `AL ${location === 'visited-peers' ? 'visited peers' : 'collection'} exceeds the entry limit`
        });
    }
    const keys = Reflect.ownKeys(value).filter((key) => !array || key !== 'length');
    if (keys.length > limit) {
        return Either.ofLeft({ code: 'oversized', message: 'AL collection exceeds the entry limit' });
    }
    if (array && keys.length !== value.length) {
        return Either.ofLeft({ code: 'malformed', message: 'AL arrays must contain only dense indexed elements' });
    }
    const children: ALMessageValue[] = [];
    let bytes = 2;
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            return Either.ofLeft({ code: 'malformed', message: 'AL fields must be enumerable data properties' });
        }
        if (array && key !== String(children.length)) {
            return Either.ofLeft({ code: 'malformed', message: 'AL arrays must contain only dense indexed elements' });
        }
        if (!array && descriptor.value === undefined) {
            continue;
        }
        if (exceedsUtf8Limit(key, byteLimits.envelopeBytes)) {
            return Either.ofLeft({ code: 'oversized', message: 'AL envelope key exceeds the byte limit' });
        }
        bytes += (array ? 0 : new TextEncoder().encode(JSON.stringify(key)).length + 1) + (children.length > 0 ? 1 : 0);
        children.push({
            value: descriptor.value,
            location: array ? 'other' : resolveALMessageResourceLocation(location, key)
        });
    }
    return Either.ofRight({ bytes, children });
}

function validateALMessageString(
    value: string,
    location: ALMessageResourceLocation,
    byteLimits: ALMessageByteLimits
): readonly ALMessageResourceIssue[] {
    if (location === 'route-identifier' && value.length > AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters) {
        return [{ code: 'oversized', message: 'AL route identifier exceeds the character limit' }];
    }
    if (exceedsUtf8Limit(value, byteLimits.envelopeBytes)) {
        return [{ code: 'oversized', message: 'AL envelope string exceeds the byte limit' }];
    }
    if (location !== 'payload-json') {
        return [];
    }
    if (exceedsUtf8Limit(value, byteLimits.payloadBytes)) {
        return [{ code: 'oversized', message: 'AL payload exceeds the byte limit' }];
    }
    try {
        JSON.parse(value);
        return [];
    }
    catch {
        return [{ code: 'malformed', message: 'AL payload must contain valid JSON' }];
    }
}

function resolveALMessageResourceLocation(parent: ALMessageResourceLocation, key: string): ALMessageResourceLocation {
    if (
        parent === 'envelope' &&
        (key === 'route' || key === 'payload' || key === 'constraints' || key === 'diagnostics')
    ) {
        return key;
    }
    if (parent === 'route' && (key === 'topicId' || key === 'contextId' || key === 'resourceId')) {
        return 'route-identifier';
    }
    if (parent === 'payload' && key === 'resource') {
        return 'payload-json';
    }
    if (parent === 'constraints' && key === 'ttlHops') {
        return 'hop-budget';
    }
    return parent === 'diagnostics' && key === 'visitedPeerIds' ? 'visited-peers' : 'other';
}

function exceedsUtf8Limit(value: string, limit: number): boolean {
    return value.length > limit || new TextEncoder().encode(value).length > limit;
}

function isValidALMessageByteLimits(byteLimits: ALMessageByteLimits): boolean {
    return Number.isSafeInteger(byteLimits.envelopeBytes) &&
        Number.isSafeInteger(byteLimits.payloadBytes) &&
        byteLimits.payloadBytes > 0 && byteLimits.envelopeBytes >= byteLimits.payloadBytes;
}
