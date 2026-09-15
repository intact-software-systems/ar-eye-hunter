import type { AuthSession } from '@shared/api/api-config.ts';
import { fnv1a64 } from '@shared/queuebox/AppQueueIdentity.ts';
import type { RallarBlackBoxTestConfig } from '../rallar-black-box-test-contracts.ts';

import type { WebSocketTicketResolution } from './browser-command-contracts.ts';
import { decodeBrowserCommandString, isBrowserCommandRecord } from './browser-command-values.ts';

export interface CommandPlaceholderValues {
    readonly session: AuthSession | undefined;
    readonly config: RallarBlackBoxTestConfig | undefined;
    readonly wsTicket: WebSocketTicketResolution | undefined;
}

const RUNTIME_IDENTITY_BASE36_LENGTH = 13;

const AUTH_PLACEHOLDER_SOURCE = String.raw`(?:\{auth\.(clientId|username|sessionId|accessToken|wsTicket)\}|` +
    String.raw`%7Bauth\.(clientId|username|sessionId|accessToken|wsTicket)%7D)`;

const CONFIG_PLACEHOLDER_SOURCE = String.raw`(?:\{config\.(apiBaseUrl|wsBaseUrl)\}|` +
    String.raw`%7Bconfig\.(apiBaseUrl|wsBaseUrl)%7D)`;

const RUNTIME_IDENTITY_PLACEHOLDER_SOURCE = String.raw`(?:\{(runId|agentId|runtimeIdentity)\}|` +
    String.raw`%7B(runId|agentId|runtimeIdentity)%7D)`;

const AUTH_PLACEHOLDER_PATTERN = new RegExp(AUTH_PLACEHOLDER_SOURCE, 'gi');
const CONFIG_PLACEHOLDER_PATTERN = new RegExp(CONFIG_PLACEHOLDER_SOURCE, 'gi');
const RUNTIME_IDENTITY_PLACEHOLDER_PATTERN = new RegExp(RUNTIME_IDENTITY_PLACEHOLDER_SOURCE, 'gi');
const AUTH_PLACEHOLDER_TEST_PATTERN = new RegExp(AUTH_PLACEHOLDER_SOURCE, 'i');
const CONFIG_PLACEHOLDER_TEST_PATTERN = new RegExp(CONFIG_PLACEHOLDER_SOURCE, 'i');
const RUNTIME_IDENTITY_PLACEHOLDER_TEST_PATTERN = new RegExp(RUNTIME_IDENTITY_PLACEHOLDER_SOURCE, 'i');
const WS_TICKET_PLACEHOLDER_TEST_PATTERN = /(?:\{auth\.wsTicket\}|%7Bauth\.wsTicket%7D)/i;

export function resolveConfigApiBaseUrl(config: RallarBlackBoxTestConfig | undefined): string | undefined {
    return toUrlPrefix(config?.apiBaseUrl ?? decodeBrowserCommandString(config?.rallar?.apiBaseUrl));
}

export function requiresAuthSessionPlaceholder<T>(value: T): boolean {
    return decodeStringLeaves(value).some((text) => AUTH_PLACEHOLDER_TEST_PATTERN.test(text));
}

export function requiresWsTicketPlaceholder<T>(value: T): boolean {
    return decodeStringLeaves(value).some((text) => WS_TICKET_PLACEHOLDER_TEST_PATTERN.test(text));
}

export function replaceCommandPlaceholders<T>(value: T, values: CommandPlaceholderValues): T {
    const requiresReplacement = decodeStringLeaves(value).some((text) =>
        AUTH_PLACEHOLDER_TEST_PATTERN.test(text) ||
        CONFIG_PLACEHOLDER_TEST_PATTERN.test(text) ||
        RUNTIME_IDENTITY_PLACEHOLDER_TEST_PATTERN.test(text)
    );
    return requiresReplacement ? toReplacedStringLeaves(value, values) : value;
}

export function decodeStringLeaves(value: unknown): readonly string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => decodeStringLeaves(item));
    }
    return isBrowserCommandRecord(value) ? Object.values(value).flatMap((item) => decodeStringLeaves(item)) : [];
}

/** Placeholders replace only string leaves with strings, so the value keeps its shape. */
function toReplacedStringLeaves<T>(value: T, values: CommandPlaceholderValues): T {
    if (typeof value === 'string') {
        return toPlaceholderReplacedText(value, values) as T;
    }
    if (Array.isArray(value)) {
        return value.map((item) => toReplacedStringLeaves(item, values)) as T;
    }
    if (!isBrowserCommandRecord(value)) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, toReplacedStringLeaves(item, values)])
    ) as T;
}

function toPlaceholderReplacedText(text: string, values: CommandPlaceholderValues): string {
    return text
        .replace(
            RUNTIME_IDENTITY_PLACEHOLDER_PATTERN,
            (_match, plainKey: string | undefined, encodedKey: string | undefined) =>
                resolveRuntimeIdentityPlaceholder(plainKey ?? encodedKey, values.config)
        )
        .replace(
            CONFIG_PLACEHOLDER_PATTERN,
            (_match, plainKey: string | undefined, encodedKey: string | undefined) =>
                resolveConfigPlaceholder(plainKey ?? encodedKey, values.config)
        )
        .replace(
            AUTH_PLACEHOLDER_PATTERN,
            (_match, plainKey: string | undefined, encodedKey: string | undefined) =>
                resolveAuthPlaceholder(plainKey ?? encodedKey, values)
        );
}

function resolveRuntimeIdentityPlaceholder(
    key: string | undefined,
    config: RallarBlackBoxTestConfig | undefined
): string {
    const replacement = key === 'runtimeIdentity'
        ? toRuntimeIdentity(config)
        : key === 'runId'
        ? config?.runId
        : config?.agentId;
    if (!replacement) {
        throw new Error(`Cannot resolve recipe placeholder {${key}} without configured ${key}.`);
    }
    return replacement;
}

function resolveConfigPlaceholder(key: string | undefined, config: RallarBlackBoxTestConfig | undefined): string {
    const replacement = key === 'apiBaseUrl' ? resolveConfigApiBaseUrl(config) : resolveConfigWsBaseUrl(config);
    if (!replacement) {
        throw new Error(`Cannot resolve recipe placeholder {config.${key}} without configured ${key}.`);
    }
    return replacement;
}

function resolveAuthPlaceholder(key: string | undefined, values: CommandPlaceholderValues): string {
    if (key === 'wsTicket') {
        if (!values.wsTicket?.ticket) {
            throw new Error('Cannot resolve recipe placeholder {auth.wsTicket} without a websocket ticket.');
        }
        return values.wsTicket.ticket;
    }
    if (!values.session) {
        throw new Error(`Cannot resolve recipe placeholder {auth.${key}} without a logged-in Rallar session.`);
    }
    switch (key) {
        case 'clientId':
            return values.session.clientId;
        case 'username':
            return values.session.username;
        case 'sessionId':
            return values.wsTicket?.sessionId ?? values.session.sessionId;
        case 'accessToken':
            return values.session.accessToken;
        default:
            return '';
    }
}

function resolveConfigWsBaseUrl(config: RallarBlackBoxTestConfig | undefined): string | undefined {
    const configured = toUrlPrefix(decodeBrowserCommandString(config?.rallar?.wsBaseUrl));
    if (configured) {
        return configured;
    }
    const apiBaseUrl = resolveConfigApiBaseUrl(config);
    if (!apiBaseUrl) {
        return undefined;
    }
    try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return toUrlPrefix(url.toString());
    }
    catch {
        return undefined;
    }
}

function toRuntimeIdentity(config: RallarBlackBoxTestConfig | undefined): string {
    if (!config?.runId || !config.agentId) {
        throw new Error(
            'Cannot resolve recipe placeholder {runtimeIdentity} without configured runId and agentId.'
        );
    }
    return fnv1a64(`${config.runId}\u0000${config.agentId}`).padStart(RUNTIME_IDENTITY_BASE36_LENGTH, '0');
}

function toUrlPrefix(value: string | undefined): string | undefined {
    const trimmed = value?.trim().replace(/\/+$/, '');
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
