import type { RallarBlackBoxTestEvent } from '@shared-test/rallar-bb-test/types.ts';

import type { WebSocketJsonObject, WebSocketJsonValue, WebSocketPayloadParseResult } from './websocket-contracts.ts';

interface MutableWebSocketJsonObject {
    [key: string]: WebSocketJsonValue;
}

export function normalizeWebSocketJsonValue(
    value: RallarBlackBoxTestEvent['payload']
): WebSocketJsonValue {
    return normalizeWebSocketJsonCandidate(value, new WeakSet<object>());
}

function normalizeWebSocketJsonCandidate(
    value: RallarBlackBoxTestEvent['payload'],
    seen: WeakSet<object>
): WebSocketJsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value !== 'object') {
        return String(value);
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);
    const normalized = Array.isArray(value)
        ? value.map((entry) => normalizeWebSocketJsonCandidate(entry, seen))
        : normalizeWebSocketJsonObject(value, seen);
    seen.delete(value);
    return normalized;
}

function normalizeWebSocketJsonObject(
    value: object,
    seen: WeakSet<object>
): WebSocketJsonObject {
    const normalized: MutableWebSocketJsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
        normalized[key] = normalizeWebSocketJsonCandidate(entry, seen);
    }
    return normalized;
}

export function parseWebSocketJsonValue(payloadText: string): WebSocketPayloadParseResult {
    try {
        return {
            ok: true,
            value: JSON.parse(payloadText) as WebSocketJsonValue
        };
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return { ok: false, error: cause.message };
    }
}

export function isWebSocketJsonObject(value: WebSocketJsonValue): value is WebSocketJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
