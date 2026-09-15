import type {
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';

import { RallarBlackBoxBrowserRallarTransport } from './browser-command-contracts.ts';

export function isBrowserCommandRecord(value: unknown): value is RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toBrowserCommandRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

export function toOptionalBrowserCommandRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function resolveFirstDefined<T>(values: readonly T[]): T | undefined {
    return values.find((value) => value !== undefined);
}

export function toStringValue(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
}

export function toPositiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : fallback;
}

export function toNonEmptyStringValue(value: unknown): string | undefined {
    const stringValue = toStringValue(value)?.trim();
    return stringValue && stringValue.length > 0 ? stringValue : undefined;
}

export function toWebSocketScope(value: unknown): 'room' | 'world' | 'all' | undefined {
    return value === 'room' || value === 'world' || value === 'all'
        ? value
        : undefined;
}

export function toRtcTransport(
    value: unknown
): RallarBlackBoxBrowserRallarTransport | undefined {
    return value === 'realtime' ||
            value === 'messages.rtc' ||
            value === 'messages.ws'
        ? value
        : undefined;
}

export function toEventTransport(
    value: unknown
): RallarBlackBoxTestTransport | undefined {
    return value === 'realtime' ||
            value === 'messages.rtc' ||
            value === 'messages.ws' ||
            value === 'ws' ||
            value === 'http'
        ? value
        : undefined;
}

export function resolveConfigProviderMode(
    config: RallarBlackBoxTestConfig | undefined
): string | undefined {
    return toStringValue(toBrowserCommandRecord(config?.control).providerMode);
}

export function isStructuredRallarWebSocketEnvelope(value: unknown): boolean {
    const record = toBrowserCommandRecord(value);
    return ['typeId', 'topicId', 'contextId', 'resourceId'].some(
        (key) => record[key] !== undefined
    );
}

export function isRuntimeNotConnectedError(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.message.includes('Black-box Rallar runtime is not connected.')
    );
}

export function toBrowserCommandErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
