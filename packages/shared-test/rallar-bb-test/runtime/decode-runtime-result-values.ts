import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type {
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';

const RUNTIME_TRANSPORTS: readonly RallarBlackBoxTestTransport[] = [
    'realtime',
    'messages.rtc',
    'messages.ws',
    'ws',
    'http'
];

export function decodeRecord(value: unknown): RallarBlackBoxTestRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RallarBlackBoxTestRecord
        : {};
}

export function decodePositiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function decodeNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function decodeFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function decodeBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

export function decodeText(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function decodeNonBlankText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function decodeTrimmedText(value: unknown): string | undefined {
    return decodeNonBlankText(value)?.trim();
}

export function decodeTransport(value: unknown): RallarBlackBoxTestTransport | undefined {
    return typeof value === 'string' && RUNTIME_TRANSPORTS.some((transport) => transport === value)
        ? value as RallarBlackBoxTestTransport
        : undefined;
}

/**
 * The value in the JSON form a control connection or an artifact carries, all the way down: absent members and functions
 * drop out, dates become text, and a value with no JSON form (undefined, a cycle, a bigint) is absent.
 */
export function decodeJsonValue(value: unknown): ApiJsonValue | undefined {
    if (value === undefined) {
        return undefined;
    }
    try {
        const text = JSON.stringify(value);
        return text === undefined ? undefined : JSON.parse(text) as ApiJsonValue;
    }
    catch {
        return undefined;
    }
}
