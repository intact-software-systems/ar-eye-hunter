import type { AuthSession } from '@shared/api/api-config.ts';
import { fnv1a64 } from '@shared/queuebox/AppQueueIdentity.ts';
import type {
    RallarBlackBoxTestConfig
} from '../rallar-black-box-test-contracts.ts';

import { WebSocketTicketResolution } from './browser-command-contracts.ts';
import { toBrowserCommandRecord, toStringValue } from './browser-command-values.ts';

export const RUNTIME_IDENTITY_BASE36_LENGTH = 13;

export const AUTH_PLACEHOLDER_SOURCE = String.raw`(?:\{auth\.(clientId|username|sessionId|accessToken|wsTicket)\}|` +
    String.raw`%7Bauth\.(clientId|username|sessionId|accessToken|wsTicket)%7D)`;

export const CONFIG_PLACEHOLDER_SOURCE = String.raw`(?:\{config\.(apiBaseUrl|wsBaseUrl)\}|` +
    String.raw`%7Bconfig\.(apiBaseUrl|wsBaseUrl)%7D)`;

export const RUNTIME_IDENTITY_PLACEHOLDER_SOURCE = String.raw`(?:\{(runId|agentId|runtimeIdentity)\}|` +
    String.raw`%7B(runId|agentId|runtimeIdentity)%7D)`;

export const AUTH_PLACEHOLDER_PATTERN = new RegExp(AUTH_PLACEHOLDER_SOURCE, 'gi');

export const CONFIG_PLACEHOLDER_PATTERN = new RegExp(CONFIG_PLACEHOLDER_SOURCE, 'gi');

export const RUNTIME_IDENTITY_PLACEHOLDER_PATTERN = new RegExp(
    RUNTIME_IDENTITY_PLACEHOLDER_SOURCE,
    'gi'
);

export const AUTH_PLACEHOLDER_TEST_PATTERN = new RegExp(AUTH_PLACEHOLDER_SOURCE, 'i');

export const CONFIG_PLACEHOLDER_TEST_PATTERN = new RegExp(
    CONFIG_PLACEHOLDER_SOURCE,
    'i'
);

export const RUNTIME_IDENTITY_PLACEHOLDER_TEST_PATTERN = new RegExp(
    RUNTIME_IDENTITY_PLACEHOLDER_SOURCE,
    'i'
);

export const WS_TICKET_PLACEHOLDER_TEST_PATTERN = /(?:\{auth\.wsTicket\}|%7Bauth\.wsTicket%7D)/i;

export const RTC_READY_PEER_IDS_PLACEHOLDER = '{rtc.readyPeerIds}';

export const RTC_READY_PEER_ID_PLACEHOLDER_PATTERN = /^\{rtc\.readyPeerIds\[(\d+)\]\}$/;

export function normalizeUrlPrefix(value: string | undefined): string | undefined {
    const trimmed = value?.trim().replace(/\/+$/, '');
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function configApiBaseUrl(
    config: RallarBlackBoxTestConfig | undefined
): string | undefined {
    return normalizeUrlPrefix(
        config?.apiBaseUrl ?? toStringValue(toBrowserCommandRecord(config?.rallar).apiBaseUrl)
    );
}

export function configWsBaseUrl(
    config: RallarBlackBoxTestConfig | undefined
): string | undefined {
    const configured = normalizeUrlPrefix(
        toStringValue(toBrowserCommandRecord(config?.rallar).wsBaseUrl)
    );
    if (configured) {
        return configured;
    }

    const apiBaseUrl = configApiBaseUrl(config);
    if (!apiBaseUrl) {
        return undefined;
    }

    try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return normalizeUrlPrefix(url.toString());
    }
    catch {
        return undefined;
    }
}

export function runtimeIdentity(config: RallarBlackBoxTestConfig | undefined): string {
    if (!config?.runId || !config.agentId) {
        throw new Error(
            'Cannot resolve recipe placeholder {runtimeIdentity} without ' +
                'configured runId and agentId.'
        );
    }

    return fnv1a64(`${config.runId}\u0000${config.agentId}`).padStart(
        RUNTIME_IDENTITY_BASE36_LENGTH,
        '0'
    );
}

export function requiresCommandPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return (
            AUTH_PLACEHOLDER_TEST_PATTERN.test(value) ||
            CONFIG_PLACEHOLDER_TEST_PATTERN.test(value) ||
            RUNTIME_IDENTITY_PLACEHOLDER_TEST_PATTERN.test(value)
        );
    }

    if (Array.isArray(value)) {
        return value.some((item) => requiresCommandPlaceholder(item));
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.values(value).some((item) => requiresCommandPlaceholder(item));
}

export function requiresAuthSessionPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return AUTH_PLACEHOLDER_TEST_PATTERN.test(value);
    }

    if (Array.isArray(value)) {
        return value.some((item) => requiresAuthSessionPlaceholder(item));
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.values(value).some((item) => requiresAuthSessionPlaceholder(item));
}

export function requiresWsTicketPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return WS_TICKET_PLACEHOLDER_TEST_PATTERN.test(value);
    }

    if (Array.isArray(value)) {
        return value.some((item) => requiresWsTicketPlaceholder(item));
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.values(value).some((item) => requiresWsTicketPlaceholder(item));
}

export function replaceCommandPlaceholdersInString(
    value: string,
    options: Readonly<{
        session?: AuthSession;
        config?: RallarBlackBoxTestConfig;
        wsTicket?: WebSocketTicketResolution;
    }>
): string {
    return value
        .replace(
            RUNTIME_IDENTITY_PLACEHOLDER_PATTERN,
            (
                _match,
                plainKey: string | undefined,
                encodedKey: string | undefined
            ) => {
                return resolveRuntimeIdentityPlaceholder(plainKey ?? encodedKey, options);
            }
        )
        .replace(
            CONFIG_PLACEHOLDER_PATTERN,
            (
                _match,
                plainKey: string | undefined,
                encodedKey: string | undefined
            ) => {
                return resolveConfigPlaceholder(plainKey ?? encodedKey, options);
            }
        )
        .replace(
            AUTH_PLACEHOLDER_PATTERN,
            (
                _match,
                plainKey: string | undefined,
                encodedKey: string | undefined
            ) => {
                return resolveAuthPlaceholder(plainKey ?? encodedKey, options);
            }
        );
}

export function replaceCommandPlaceholders<T>(
    value: T,
    options: Readonly<{
        session?: AuthSession;
        config?: RallarBlackBoxTestConfig;
        wsTicket?: WebSocketTicketResolution;
    }>
): T {
    if (!requiresCommandPlaceholder(value)) {
        return value;
    }

    function replace(current: unknown): unknown {
        if (typeof current === 'string') {
            return replaceCommandPlaceholdersInString(current, options);
        }

        if (Array.isArray(current)) {
            return current.map((item) => replace(item));
        }

        if (!current || typeof current !== 'object') {
            return current;
        }

        return Object.fromEntries(
            Object.entries(current).map(([key, item]) => [key, replace(item)])
        );
    }

    return replace(value) as T;
}

export function requiresRtcReadyPeerPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return (
            value === RTC_READY_PEER_IDS_PLACEHOLDER ||
            RTC_READY_PEER_ID_PLACEHOLDER_PATTERN.test(value)
        );
    }

    if (Array.isArray(value)) {
        return value.some((item) => requiresRtcReadyPeerPlaceholder(item));
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.values(value).some((item) => requiresRtcReadyPeerPlaceholder(item));
}

export function replaceRtcReadyPeerPlaceholders(
    value: unknown,
    readyPeerIds: readonly string[]
): unknown {
    function replace(current: unknown): unknown {
        if (typeof current === 'string') {
            if (current === RTC_READY_PEER_IDS_PLACEHOLDER) {
                return [...readyPeerIds];
            }

            const indexed = RTC_READY_PEER_ID_PLACEHOLDER_PATTERN.exec(current);
            if (indexed) {
                const index = Number.parseInt(indexed[1] ?? '', 10);
                const peerId = readyPeerIds[index];
                if (!peerId) {
                    throw new Error(
                        `Cannot resolve recipe placeholder ${current}; ` +
                            `only ${readyPeerIds.length} RTC ready peer(s) are available.`
                    );
                }

                return peerId;
            }
        }

        if (Array.isArray(current)) {
            return current.flatMap((item) => {
                const replaced = replace(item);
                return Array.isArray(replaced) ? replaced : [replaced];
            });
        }

        if (!current || typeof current !== 'object') {
            return current;
        }

        return Object.fromEntries(
            Object.entries(current).map(([key, item]) => [key, replace(item)])
        );
    }

    return replace(value);
}
interface CommandPlaceholderValues {
    readonly session?: AuthSession;
    readonly config?: RallarBlackBoxTestConfig;
    readonly wsTicket?: WebSocketTicketResolution;
}
function resolveRuntimeIdentityPlaceholder(key: string | undefined, options: CommandPlaceholderValues): string {
    const replacement = key === 'runtimeIdentity'
        ? runtimeIdentity(options.config)
        : key === 'runId'
        ? options.config?.runId
        : options.config?.agentId;
    if (!replacement) {
        throw new Error(
            `Cannot resolve recipe placeholder {${key}} without configured ${key}.`
        );
    }

    return replacement;
}
function resolveConfigPlaceholder(key: string | undefined, options: CommandPlaceholderValues): string {
    const replacement = key === 'apiBaseUrl'
        ? configApiBaseUrl(options.config)
        : configWsBaseUrl(options.config);
    if (!replacement) {
        throw new Error(
            `Cannot resolve recipe placeholder {config.${key}} ` +
                `without configured ${key}.`
        );
    }

    return replacement;
}
function resolveAuthPlaceholder(key: string | undefined, options: CommandPlaceholderValues): string {
    if (key === 'wsTicket') {
        if (!options.wsTicket?.ticket) {
            throw new Error(
                'Cannot resolve recipe placeholder {auth.wsTicket} ' +
                    'without a websocket ticket.'
            );
        }

        return options.wsTicket.ticket;
    }

    if (!options.session) {
        throw new Error(
            `Cannot resolve recipe placeholder {auth.${key}} ` +
                'without a logged-in Rallar session.'
        );
    }

    switch (key) {
        case 'clientId':
            return options.session.clientId;
        case 'username':
            return options.session.username;
        case 'sessionId':
            return options.wsTicket?.sessionId ?? options.session.sessionId;
        case 'accessToken':
            return options.session.accessToken;
        default:
            return '';
    }
}
