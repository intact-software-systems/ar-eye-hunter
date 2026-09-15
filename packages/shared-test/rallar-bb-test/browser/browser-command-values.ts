import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

import type { CommandWithId, RallarBlackBoxBrowserRallarTransport } from './browser-command-contracts.ts';

const WEB_SOCKET_SCOPES = ['room', 'world', 'all'] as const;
const RTC_TRANSPORTS: readonly RallarBlackBoxBrowserRallarTransport[] = ['realtime', 'messages.rtc', 'messages.ws'];

export function isBrowserCommandRecord(value: unknown): value is RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A recipe field read as a record; any other value reads as absent. */
export function decodeBrowserCommandRecord(value: unknown): RallarBlackBoxTestRecord | undefined {
    return isBrowserCommandRecord(value) ? value : undefined;
}

/** A recipe field in its string form; only an absent or null field reads as absent. */
export function decodeBrowserCommandString(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
}

export function decodeNonEmptyBrowserCommandString(value: unknown): string | undefined {
    const text = decodeBrowserCommandString(value)?.trim();
    return text && text.length > 0 ? text : undefined;
}

export function decodeWebSocketScope(value: unknown): 'room' | 'world' | 'all' | undefined {
    return typeof value === 'string' ? WEB_SOCKET_SCOPES.find((scope) => scope === value) : undefined;
}

export function decodeRtcTransport(value: unknown): RallarBlackBoxBrowserRallarTransport | undefined {
    return typeof value === 'string' ? RTC_TRANSPORTS.find((transport) => transport === value) : undefined;
}

/** A command's fields by name, for page runtime inputs that forward every field the recipe set. */
export function toBrowserCommandFields(command: CommandWithId): RallarBlackBoxTestRecord {
    return Object.fromEntries(Object.entries(command));
}

export function resolveFirstDefined<T>(values: readonly T[]): T | undefined {
    return values.find((value) => value !== undefined);
}

export function toPositiveInteger(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function isStructuredRallarWebSocketEnvelope(value: unknown): value is RallarBlackBoxTestRecord {
    return isBrowserCommandRecord(value) &&
        ['typeId', 'topicId', 'contextId', 'resourceId'].some((key) => value[key] !== undefined);
}

export function isRuntimeNotConnectedError(error: unknown): error is Error {
    return error instanceof Error && error.message.includes('Black-box Rallar runtime is not connected.');
}
