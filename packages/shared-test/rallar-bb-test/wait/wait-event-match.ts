import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestEvent, RallarBlackBoxTestWaitMatch } from '../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

/** A path either reaches a value in its JSON form or it does not. */
export type PayloadPathLookup =
    | Readonly<{ exists: false; }>
    | Readonly<{ exists: true; value: ApiJsonValue; }>;

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

/**
 * An absent or blank path reads the whole payload. The reached value is read in the JSON form the control connection
 * carries it, so a member without a JSON form is not reached.
 */
export function decodePayloadPathValue(payload: unknown, path: string | undefined): PayloadPathLookup {
    return decodePathSegmentsValue(payload, toPayloadPathSegments(path));
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

function toPayloadPathSegments(path: string | undefined): readonly string[] {
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

function decodePathSegmentsValue(value: unknown, segments: readonly string[]): PayloadPathLookup {
    const [segment, ...rest] = segments;
    if (segment === undefined) {
        const json = decodeJsonValue(value);
        return json === undefined ? MISSING_PATH_VALUE : { exists: true, value: json };
    }
    if ((Array.isArray(value) || typeof value === 'string') && segment === 'length') {
        return decodePathSegmentsValue(value.length, rest);
    }
    if (Array.isArray(value)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0 || index >= value.length) {
            return MISSING_PATH_VALUE;
        }
        // JSON writes an array element that has no JSON form as null.
        const hasJsonForm = value[index] !== undefined &&
            typeof value[index] !== 'function' &&
            typeof value[index] !== 'symbol';
        return decodePathSegmentsValue(hasJsonForm ? value[index] : null, rest);
    }
    return isJsonRecordValue(value) && Object.hasOwn(value, segment)
        ? decodePathSegmentsValue(value[segment], rest)
        : MISSING_PATH_VALUE;
}
