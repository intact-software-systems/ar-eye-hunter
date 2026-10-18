import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestEvent, RallarBlackBoxTestWaitMatch } from '../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

/** A path either reaches a value in its JSON form or it does not. */
export type PayloadPathLookup =
    | Readonly<{ exists: false; }>
    | Readonly<{ exists: true; value: ApiJsonValue; }>;

export interface PayloadPathReference {
    readonly lookup: PayloadPathLookup;
    readonly object: object | undefined;
}

type WaitEventRoutingKey = keyof RallarBlackBoxTestWaitMatch & keyof RallarBlackBoxTestEvent;

const MISSING_PATH_VALUE: PayloadPathLookup = { exists: false };
const MISSING_PATH_REFERENCE: PayloadPathReference = { lookup: MISSING_PATH_VALUE, object: undefined };
const PAYLOAD_PATH_PREFIXES = ['$.payload.', 'payload.', '$.'];
const WAIT_EVENT_ROUTING_KEYS: readonly WaitEventRoutingKey[] = [
    'kind',
    'topic',
    'commandId',
    'connection',
    'transport',
    'severity'
];

/**
 * An absent or blank path reads the whole payload. The reached value is read in the JSON form the control connection
 * carries it, so a member without a JSON form is not reached.
 */
export function decodePayloadPathValue(payload: unknown, path: string | undefined): PayloadPathLookup {
    return decodePathSegmentsReference(payload, toPayloadPathSegments(path)).lookup;
}

export function isSameJsonValue(left: ApiJsonValue | undefined, right: ApiJsonValue | undefined): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function hasContainedText(value: ApiJsonValue | undefined, expected: string): boolean {
    return typeof value === 'string'
        ? value.includes(expected)
        : (JSON.stringify(value) ?? String(value)).includes(expected);
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

export function toPayloadPathSegments(path: string | undefined): readonly string[] {
    if (path === undefined || path.trim().length === 0) {
        return [];
    }
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
        Object.entries(match.payloadFields ?? {}).every(([path, expected]) => {
            const lookup = decodePayloadPathValue(event.payload, path);
            return lookup.exists && isSameJsonValue(lookup.value, expected);
        }) &&
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

/** Keeps the reached object as an opaque identity beside its decoded JSON value for ownership checks. */
export function decodePathSegmentsReference(value: unknown, segments: readonly string[]): PayloadPathReference {
    const [segment, ...rest] = segments;
    if (segment === undefined) {
        const json = decodeJsonValue(value);
        return {
            lookup: json === undefined ? MISSING_PATH_VALUE : { exists: true, value: json },
            object: typeof value === 'object' && value !== null ? value : undefined
        };
    }
    if ((Array.isArray(value) || typeof value === 'string') && segment === 'length') {
        return decodePathSegmentsReference(value.length, rest);
    }
    if (Array.isArray(value)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0 || index >= value.length) {
            return MISSING_PATH_REFERENCE;
        }
        // JSON writes an array element that has no JSON form as null.
        const hasJsonForm = value[index] !== undefined &&
            typeof value[index] !== 'function' &&
            typeof value[index] !== 'symbol';
        return decodePathSegmentsReference(hasJsonForm ? value[index] : null, rest);
    }
    return isJsonRecordValue(value) && Object.hasOwn(value, segment)
        ? decodePathSegmentsReference(value[segment], rest)
        : MISSING_PATH_REFERENCE;
}
