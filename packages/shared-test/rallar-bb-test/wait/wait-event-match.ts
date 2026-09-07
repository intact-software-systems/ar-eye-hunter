import type { RallarBlackBoxTestEvent, RallarBlackBoxTestWaitMatch } from '../types.ts';

export type PayloadPathLookup = Readonly<{
    exists: boolean;
    value?: unknown;
}>;

function normalisePayloadPath(path: string): string {
    if (path.startsWith('$.payload.')) {
        return path.slice('$.payload.'.length);
    }
    if (path.startsWith('payload.')) {
        return path.slice('payload.'.length);
    }
    if (path.startsWith('$.')) {
        return path.slice('$.'.length);
    }
    return path;
}

export function lookupPayloadPath(payload: unknown, path: string | undefined): PayloadPathLookup {
    if (!path || path.trim().length === 0) {
        return {
            exists: payload !== undefined,
            value: payload
        };
    }

    let current = payload;
    const segments = normalisePayloadPath(path)
        .split('.')
        .filter((segment) => segment.length > 0);
    for (const segment of segments) {
        if ((Array.isArray(current) || typeof current === 'string') && segment === 'length') {
            current = current.length;
            continue;
        }

        if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                return { exists: false };
            }
            current = current[index];
            continue;
        }

        if (!current || typeof current !== 'object') {
            return { exists: false };
        }

        const record = current as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(record, segment)) {
            return { exists: false };
        }
        current = record[segment];
    }

    return {
        exists: true,
        value: current
    };
}

export function sameJsonValue(left: unknown, right: unknown): boolean {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    }
    catch (_error) {
        return Object.is(left, right);
    }
}

export function containsValue(value: unknown, expected: string): boolean {
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

export function waitEventMatches(
    event: RallarBlackBoxTestEvent,
    match: RallarBlackBoxTestWaitMatch
): boolean {
    if (match.sinceEpochMs !== undefined && event.atEpochMs < match.sinceEpochMs) {
        return false;
    }
    if (match.kind !== undefined && event.kind !== match.kind) {
        return false;
    }
    if (match.topic !== undefined && event.topic !== match.topic) {
        return false;
    }
    if (match.commandId !== undefined && event.commandId !== match.commandId) {
        return false;
    }
    if (match.connection !== undefined && event.connection !== match.connection) {
        return false;
    }
    if (match.transport !== undefined && event.transport !== match.transport) {
        return false;
    }
    if (match.severity !== undefined && event.severity !== match.severity) {
        return false;
    }

    if (
        match.payloadPath !== undefined ||
        match.equals !== undefined ||
        match.contains !== undefined ||
        match.exists !== undefined
    ) {
        const lookup = lookupPayloadPath(event.payload, match.payloadPath);
        if (match.exists !== undefined && lookup.exists !== match.exists) {
            return false;
        }
        if (match.exists !== false && !lookup.exists) {
            return false;
        }
        if (match.equals !== undefined && !sameJsonValue(lookup.value, match.equals)) {
            return false;
        }
        if (match.contains !== undefined && !containsValue(lookup.value, match.contains)) {
            return false;
        }
    }

    return true;
}

export function findWaitEvent(
    events: readonly RallarBlackBoxTestEvent[],
    match: RallarBlackBoxTestWaitMatch
): RallarBlackBoxTestEvent | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        if (waitEventMatches(event, match)) {
            return event;
        }
    }
    return undefined;
}
