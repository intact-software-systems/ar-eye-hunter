import type { RallarBlackBoxTestEvent, RallarBlackBoxTestWaitMatch } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

/** Evidence stays opaque: a path either reaches a value or it does not. */
export type PayloadPathLookup =
    | Readonly<{ exists: false; }>
    | Readonly<{ exists: true; value: unknown; }>;

type WaitEventRoutingKey = keyof RallarBlackBoxTestWaitMatch & keyof RallarBlackBoxTestEvent;

const MISSING_PATH_VALUE: PayloadPathLookup = { exists: false };
const PAYLOAD_PATH_PREFIXES = ['$.payload.', 'payload.', '$.'];
const WAIT_EVENT_ROUTING_KEYS: readonly WaitEventRoutingKey[] = [
    'kind',
    'topic',
    'commandId',
    'connection',
    'transport',
    'severity'
];

/** An absent or blank path reads the whole payload. */
export function decodePayloadPathValue(payload: unknown, path: string | undefined): PayloadPathLookup {
    if (path === undefined || path.trim().length === 0) {
        return payload === undefined ? MISSING_PATH_VALUE : { exists: true, value: payload };
    }
    let lookup: PayloadPathLookup = { exists: true, value: payload };
    for (const segment of toPayloadPathSegments(path)) {
        if (!lookup.exists) {
            return lookup;
        }
        lookup = decodePayloadPathSegment(lookup.value, segment);
    }
    return lookup;
}

export function isSameJsonValue(left: unknown, right: unknown): boolean {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    }
    catch (_error) {
        return Object.is(left, right);
    }
}

export function hasContainedText(value: unknown, expected: string): boolean {
    if (typeof value === 'string') {
        return value.includes(expected);
    }
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string'
            ? serialized.includes(expected)
            : String(value).includes(expected);
    }
    catch (_error) {
        return String(value).includes(expected);
    }
}

/** The latest matching event wins. */
export function resolveLatestWaitEvent(
    events: readonly RallarBlackBoxTestEvent[],
    match: RallarBlackBoxTestWaitMatch
): RallarBlackBoxTestEvent | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
        if (isWaitEventMatch(events[index], match)) {
            return events[index];
        }
    }
    return undefined;
}

function toPayloadPathSegments(path: string): readonly string[] {
    const prefix = PAYLOAD_PATH_PREFIXES.find((candidate) => path.startsWith(candidate));
    return (prefix === undefined ? path : path.slice(prefix.length))
        .split('.')
        .filter((segment) => segment.length > 0);
}

function isWaitEventMatch(event: RallarBlackBoxTestEvent, match: RallarBlackBoxTestWaitMatch): boolean {
    if (match.sinceEpochMs !== undefined && event.atEpochMs < match.sinceEpochMs) {
        return false;
    }
    return WAIT_EVENT_ROUTING_KEYS.every((key) => match[key] === undefined || event[key] === match[key]) &&
        isWaitEventPayloadMatch(event, match);
}

function isWaitEventPayloadMatch(event: RallarBlackBoxTestEvent, match: RallarBlackBoxTestWaitMatch): boolean {
    const { payloadPath, equals, contains, exists } = match;
    if (payloadPath === undefined && equals === undefined && contains === undefined && exists === undefined) {
        return true;
    }
    const lookup = decodePayloadPathValue(event.payload, payloadPath);
    const value = lookup.exists ? lookup.value : undefined;
    return (exists === undefined ? lookup.exists : lookup.exists === exists) &&
        (equals === undefined || isSameJsonValue(value, equals)) &&
        (contains === undefined || hasContainedText(value, contains));
}

function decodePayloadPathSegment(value: unknown, segment: string): PayloadPathLookup {
    if ((Array.isArray(value) || typeof value === 'string') && segment === 'length') {
        return { exists: true, value: value.length };
    }
    if (Array.isArray(value)) {
        const index = Number(segment);
        return Number.isInteger(index) && index >= 0 && index < value.length
            ? { exists: true, value: value[index] }
            : MISSING_PATH_VALUE;
    }
    return isJsonRecordValue(value) && Object.hasOwn(value, segment)
        ? { exists: true, value: value[segment] }
        : MISSING_PATH_VALUE;
}
