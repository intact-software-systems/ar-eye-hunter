import type { CreateRallarBlackBoxTestRuntimeOptions, } from './runtime.ts';
import { createRallarBlackBoxTestRuntime } from './runtime.ts';
import {
    inferRallarBlackBoxDiagnosticSeverity,
    normalizeRallarBlackBoxRuntimeDiagnostic,
} from './diagnostics.ts';
import {
    planRallarBlackBoxRtcStreamFrames,
    replaceRallarBlackBoxRtcStreamPlaceholders,
    sampleRallarBlackBoxRtcStreamObservations,
    summarizeRallarBlackBoxRtcStreamObservations,
} from './rtc-stream.ts';
import { readSession } from '@shared/api/auth.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestCleanupInput,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestRtcStreamFrameObservation,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestTransport,
} from './types.ts';

export type RallarBlackBoxBrowserRallarTransport = Extract<
    RallarBlackBoxTestTransport,
    'realtime' | 'messages.rtc'
>;

export type RallarBlackBoxBrowserRallarConnectionConfig = Readonly<{
    connection: string;
    actor?: string;
    peerId?: string;
    remotePeerId?: string;
    roomId?: string;
    roomRef?: Readonly<Record<string, unknown>>;
    rallar: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxBrowserRallarCrdtRuntime = Readonly<{
    open(input: unknown): Promise<unknown>;
    apply(input: unknown): Promise<unknown>;
    read(input: unknown): Promise<unknown>;
    sync(input: unknown): Promise<unknown>;
    health(input: unknown): Promise<unknown>;
    wait(input: unknown): Promise<unknown>;
    undo(input: unknown): Promise<unknown>;
    redo(input: unknown): Promise<unknown>;
    close(input: unknown): Promise<unknown>;
    destroy(input: unknown): Promise<unknown>;
}>;

export type RallarBlackBoxBrowserRallarDirectorRuntime = Readonly<{
    appoint(input: unknown): Promise<unknown>;
    resign(input: unknown): Promise<unknown>;
    status(input: unknown): Promise<unknown>;
    relayStart(input: unknown): Promise<unknown>;
    intent(input: unknown): Promise<unknown>;
    syncRequest(input: unknown): Promise<unknown>;
    relayStop(input: unknown): Promise<unknown>;
}>;

export type RallarBlackBoxBrowserRallarRuntime = Readonly<{
    connect(config: RallarBlackBoxBrowserRallarConnectionConfig): Promise<unknown>;
    send(input: unknown): Promise<unknown>;
    sendWs?(input: unknown): Promise<unknown>;
    crdt?: RallarBlackBoxBrowserRallarCrdtRuntime;
    director?: RallarBlackBoxBrowserRallarDirectorRuntime;
    close(): Promise<unknown>;
    health(): Promise<unknown>;
}>;

type RallarBlackBoxBrowserRallarCrdtMethod =
    keyof RallarBlackBoxBrowserRallarCrdtRuntime;
type RallarBlackBoxBrowserRallarDirectorMethod =
    keyof RallarBlackBoxBrowserRallarDirectorRuntime;

export type RallarBlackBoxBrowserRallarEvent = Readonly<{
    kind?: 'diagnostic' | 'message' | 'close';
    topic?: string;
    connection?: string;
    actor?: string;
    transport?: RallarBlackBoxTestTransport;
    severity?: 'debug' | 'info' | 'warning' | 'error';
    atEpochMs?: number;
    roomId?: string;
    roomRef?: Readonly<Record<string, unknown>>;
    scope?: Readonly<Record<string, unknown>>;
    applicationId?: string;
    workspaceId?: string;
    laneId?: string;
    peerId?: string;
    remotePeerId?: string;
    senderId?: string;
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    data?: unknown;
    error?: unknown;
    [key: string]: unknown;
}>;

export type RallarBlackBoxBrowserWebSocket = {
    readonly readyState?: number;
    readonly protocol?: string;
    readonly url?: string;
    readonly bufferedAmount?: number;
    send(data: unknown): void;
    close(code?: number, reason?: string): void;
    addEventListener?: (type: string, listener: (event: unknown) => void) => void;
    removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
    onopen?: ((event: unknown) => void) | null;
    onmessage?: ((event: unknown) => void) | null;
    onclose?: ((event: unknown) => void) | null;
    onerror?: ((event: unknown) => void) | null;
};

export type RallarBlackBoxBrowserWebSocketFactory = (
    url: string,
    protocols?: string | readonly string[],
) => RallarBlackBoxBrowserWebSocket;

export type RallarBlackBoxBrowserTestRuntime = RallarBlackBoxTestRuntime & Readonly<{
    receiveRallarBrowserEvent(event: RallarBlackBoxBrowserRallarEvent): void;
}>;

export type CreateRallarBlackBoxBrowserTestRuntimeOptions =
    & Omit<CreateRallarBlackBoxTestRuntimeOptions, 'commandExecutor'>
    & Readonly<{
    rallarRuntime?: RallarBlackBoxBrowserRallarRuntime;
    fetch?: typeof fetch;
    webSocketFactory?: RallarBlackBoxBrowserWebSocketFactory;
    defaultWsOpenTimeoutMs?: number;
    defaultHttpBodyLimit?: number;
}>;

type CommandWithId = RallarBlackBoxTestCommand & Readonly<{ commandId: string }>;

type HttpBodyMode = 'none' | 'text' | 'json';

type HttpResponseOptions = Readonly<{
    body?: HttpBodyMode;
    maxBodyChars?: number;
}>;

type WebSocketTicketResolution = Readonly<{
    ticket: string;
    sessionId?: string;
}>;

const DEFAULT_WS_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_HTTP_BODY_LIMIT = 64_000;

const WEBSOCKET_OPEN_STATE = 1;
const AUTH_PLACEHOLDER_PATTERN = /(?:\{auth\.(clientId|username|sessionId|accessToken|wsTicket)\}|%7Bauth\.(clientId|username|sessionId|accessToken|wsTicket)%7D)/gi;
const CONFIG_PLACEHOLDER_PATTERN = /(?:\{config\.(apiBaseUrl|wsBaseUrl)\}|%7Bconfig\.(apiBaseUrl|wsBaseUrl)%7D)/gi;
const AUTH_PLACEHOLDER_TEST_PATTERN = /(?:\{auth\.(clientId|username|sessionId|accessToken|wsTicket)\}|%7Bauth\.(clientId|username|sessionId|accessToken|wsTicket)%7D)/i;
const CONFIG_PLACEHOLDER_TEST_PATTERN = /(?:\{config\.(apiBaseUrl|wsBaseUrl)\}|%7Bconfig\.(apiBaseUrl|wsBaseUrl)%7D)/i;
const WS_TICKET_PLACEHOLDER_TEST_PATTERN = /(?:\{auth\.wsTicket\}|%7Bauth\.wsTicket%7D)/i;

const RTC_FAILURE_STATUSES = new Set([
    'no-peers',
    'no-route',
    'failed',
    'rate-limited',
    'circuit-open',
    'skipped',
    'expired',
]);

const RTC_DATA_CHANNEL_FAILURE_STATUSES = new Set([
    'closed',
    'dropped',
]);

type RtcSendFailure = Readonly<{
    code: string;
    message: string;
    details?: unknown;
}>;

type RtcConnectReadinessOptions = Readonly<{
    minReadyPeers: number;
    timeoutMs: number;
    intervalMs: number;
}>;

type RtcConnectReadinessResult = Readonly<{
    ready: boolean;
    minReadyPeers: number;
    timeoutMs: number;
    intervalMs: number;
    waitedMs: number;
    readyPeerIds: readonly string[];
    health?: unknown;
}>;

const RTC_READY_PEER_IDS_PLACEHOLDER = '{rtc.readyPeerIds}';
const RTC_READY_PEER_ID_PLACEHOLDER_PATTERN = /^\{rtc\.readyPeerIds\[(\d+)\]\}$/;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function firstDefined<T>(...values: readonly T[]): T | undefined {
    return values.find(value => value !== undefined);
}

function toStringValue(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
}

function toPositiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : fallback;
}

function toRtcReadyPeerIds(value: unknown): readonly string[] {
    const root = asRecord(value);
    const rtcStatus = asRecord(root.rtcStatus);
    const readyPeerIds = Array.isArray(rtcStatus.readyPeerIds)
        ? rtcStatus.readyPeerIds
        : Array.isArray(root.readyPeerIds)
            ? root.readyPeerIds
            : [];
    return readyPeerIds.filter((peerId): peerId is string => typeof peerId === 'string');
}

function requiresRtcReadyPeerPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return value === RTC_READY_PEER_IDS_PLACEHOLDER ||
            RTC_READY_PEER_ID_PLACEHOLDER_PATTERN.test(value);
    }

    if (Array.isArray(value)) {
        return value.some(item => requiresRtcReadyPeerPlaceholder(item));
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.values(value).some(item => requiresRtcReadyPeerPlaceholder(item));
}

function replaceRtcReadyPeerPlaceholders(
    value: unknown,
    readyPeerIds: readonly string[],
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
                            `only ${readyPeerIds.length} RTC ready peer(s) are available.`,
                    );
                }

                return peerId;
            }
        }

        if (Array.isArray(current)) {
            return current.flatMap(item => {
                const replaced = replace(item);
                return Array.isArray(replaced) ? replaced : [replaced];
            });
        }

        if (!current || typeof current !== 'object') {
            return current;
        }

        return Object.fromEntries(
            Object.entries(current).map(([key, item]) => [key, replace(item)]),
        );
    }

    return replace(value);
}

function commandLocalDelayMs(command: CommandWithId): number {
    const value = command.metadata?.localDelayMs;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, value);
}

function withSendObservationValue(
    value: unknown,
    sendObservation: Readonly<Record<string, unknown>>,
): unknown {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? {
            ...(value as Record<string, unknown>),
            sendObservation,
        }
        : {
            diagnostics: value,
            sendObservation,
        };
}

function withRtcConnectReadinessValue(
    value: unknown,
    readiness: RtcConnectReadinessResult,
): unknown {
    const readinessValue = {
        ready: readiness.ready,
        minReadyPeers: readiness.minReadyPeers,
        timeoutMs: readiness.timeoutMs,
        intervalMs: readiness.intervalMs,
        waitedMs: readiness.waitedMs,
        readyPeerIds: readiness.readyPeerIds,
        health: readiness.health,
    };
    return value && typeof value === 'object' && !Array.isArray(value)
        ? {
            ...(value as Record<string, unknown>),
            readiness: readinessValue,
        }
        : {
            diagnostics: value,
            readiness: readinessValue,
        };
}

function countDataChannelStatuses(diagnostics: unknown, status: string): number | undefined {
    const root = asRecord(diagnostics);
    if (!Array.isArray(root.results)) {
        return undefined;
    }

    const count = root.results.filter((entry) => {
        const result = asRecord(asRecord(entry).result);
        return result.status === status;
    }).length;
    return count > 0 ? count : undefined;
}

function rtcSendObservation(
    command: Extract<CommandWithId, { kind: 'rtc.send' }>,
    diagnostics: unknown,
    durationMs: number,
    ok: boolean,
    errorCode?: string,
): Readonly<Record<string, unknown>> {
    const root = asRecord(diagnostics);
    const message = asRecord(root.message);
    const status = firstDefined(
        toStringValue(root.status),
        toStringValue(message.status),
    );
    return {
        commandId: command.commandId,
        kind: command.kind,
        transport: command.transport,
        durationMs,
        ok,
        status,
        queued: status === 'queued' || status === 'buffered',
        enqueued: status === 'enqueued',
        backpressured: status === 'backpressure' ||
            status === 'backpressured' ||
            status === 'rate-limited' ||
            status === 'buffer-full' ||
            status === 'circuit-open',
        droppedPayloadCount: countDataChannelStatuses(diagnostics, 'dropped'),
        replacedPayloadCount: firstDefined(
            typeof root.replacedPayloadCount === 'number' ? root.replacedPayloadCount : undefined,
            typeof root.replacedCount === 'number' ? root.replacedCount : undefined,
        ),
        errorCode,
    };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (signal?.aborted) {
        return Promise.reject(toAbortError(signal.reason));
    }

    return new Promise((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
            cleanup();
            reject(toAbortError(signal?.reason));
        };

        timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal?.addEventListener('abort', abort, {
            once: true,
        });
    });
}

function toAbortError(reason: unknown): Error {
    if (reason instanceof Error) {
        return reason;
    }

    const message = typeof reason === 'string' && reason.length > 0
        ? reason
        : 'Rallar black-box browser adapter operation was cancelled.';
    const error = new Error(message);
    error.name = 'RALLAR_BLACK_BOX_ABORTED';
    return error;
}

function toTimeoutError(): Error {
    const error = new Error('Rallar black-box command timeout reached.');
    error.name = 'RALLAR_BLACK_BOX_TIMEOUT';
    return error;
}

function nonEmptyStringValue(value: unknown): string | undefined {
    const stringValue = toStringValue(value)?.trim();
    return stringValue && stringValue.length > 0 ? stringValue : undefined;
}

function wsScopeValue(value: unknown): 'room' | 'world' | 'all' | undefined {
    return value === 'room' || value === 'world' || value === 'all'
        ? value
        : undefined;
}

function rtcSendFailureFromDiagnostics(diagnostics: unknown): RtcSendFailure | undefined {
    const root = asRecord(diagnostics);
    const status = toStringValue(root.status);
    if (status && RTC_FAILURE_STATUSES.has(status)) {
        return {
            code: status === 'no-peers'
                ? 'RALLAR_BB_RTC_NO_PEERS'
                : 'RALLAR_BB_RTC_SEND_FAILED',
            message: status === 'no-peers'
                ? 'RTC send resolved no target peers.'
                : `RTC send failed with status: ${status}.`,
            details: diagnostics,
        };
    }

    const message = asRecord(root.message);
    const messageStatus = toStringValue(message.status);
    if (messageStatus && RTC_FAILURE_STATUSES.has(messageStatus)) {
        return {
            code: messageStatus === 'no-route'
                ? 'RALLAR_BB_RTC_NO_ROUTE'
                : 'RALLAR_BB_RTC_SEND_FAILED',
            message: message.reason
                ? `RTC send failed with status ${messageStatus}: ${String(message.reason)}`
                : `RTC send failed with status: ${messageStatus}.`,
            details: diagnostics,
        };
    }

    const failedResults = Array.isArray(root.results)
        ? root.results.filter((entry) => {
            const result = asRecord(asRecord(entry).result);
            const resultStatus = toStringValue(result.status);
            return Boolean(resultStatus && RTC_DATA_CHANNEL_FAILURE_STATUSES.has(resultStatus));
        })
        : [];
    if (failedResults.length > 0) {
        return {
            code: 'RALLAR_BB_RTC_PEER_SEND_FAILED',
            message: `RTC send failed for ${failedResults.length} peer(s).`,
            details: {
                diagnostics,
                failedResults,
            },
        };
    }

    return undefined;
}

function toRtcTransport(
    value: unknown,
): RallarBlackBoxBrowserRallarTransport | undefined {
    return value === 'realtime' || value === 'messages.rtc'
        ? value
        : undefined;
}

function toEventTransport(value: unknown): RallarBlackBoxTestTransport | undefined {
    return value === 'realtime' ||
    value === 'messages.rtc' ||
    value === 'ws' ||
    value === 'http'
        ? value
        : undefined;
}

function configProviderMode(config: RallarBlackBoxTestConfig | undefined): string | undefined {
    return toStringValue(asRecord(config?.control).providerMode);
}

function isStructuredRallarWebSocketEnvelope(value: unknown): boolean {
    const record = asRecord(value);
    return [
        'typeId',
        'topicId',
        'contextId',
        'resourceId',
    ].some(key => record[key] !== undefined);
}

function isRuntimeNotConnectedError(error: unknown): boolean {
    return error instanceof Error &&
        error.message.includes('Black-box Rallar runtime is not connected.');
}

function toHeadersRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}

function readOptionalBrowserSession(): AuthSession | undefined {
    if (typeof localStorage === 'undefined') {
        return undefined;
    }

    try {
        return readSession();
    } catch {
        return undefined;
    }
}

function normalizeUrlPrefix(value: string | undefined): string | undefined {
    const trimmed = value?.trim().replace(/\/+$/, '');
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function configApiBaseUrl(config: RallarBlackBoxTestConfig | undefined): string | undefined {
    return normalizeUrlPrefix(
        config?.apiBaseUrl ?? toStringValue(asRecord(config?.rallar).apiBaseUrl),
    );
}

function configWsBaseUrl(config: RallarBlackBoxTestConfig | undefined): string | undefined {
    const configured = normalizeUrlPrefix(toStringValue(asRecord(config?.rallar).wsBaseUrl));
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
    } catch {
        return undefined;
    }
}

function requiresAuthPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return AUTH_PLACEHOLDER_TEST_PATTERN.test(value) || CONFIG_PLACEHOLDER_TEST_PATTERN.test(value);
    }

    if (Array.isArray(value)) {
        return value.some(item => requiresAuthPlaceholder(item));
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.values(value).some(item => requiresAuthPlaceholder(item));
}

function requiresAuthSessionPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return AUTH_PLACEHOLDER_TEST_PATTERN.test(value);
    }

    if (Array.isArray(value)) {
        return value.some(item => requiresAuthSessionPlaceholder(item));
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.values(value).some(item => requiresAuthSessionPlaceholder(item));
}

function requiresWsTicketPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return WS_TICKET_PLACEHOLDER_TEST_PATTERN.test(value);
    }

    if (Array.isArray(value)) {
        return value.some(item => requiresWsTicketPlaceholder(item));
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.values(value).some(item => requiresWsTicketPlaceholder(item));
}

function replaceCommandPlaceholdersInString(
    value: string,
    options: Readonly<{
        session?: AuthSession;
        config?: RallarBlackBoxTestConfig;
        wsTicket?: WebSocketTicketResolution;
    }>,
): string {
    return value
        .replace(CONFIG_PLACEHOLDER_PATTERN, (_match, plainKey: string | undefined, encodedKey: string | undefined) => {
            const key = plainKey ?? encodedKey;
            const replacement = key === 'apiBaseUrl'
                ? configApiBaseUrl(options.config)
                : configWsBaseUrl(options.config);
            if (!replacement) {
                throw new Error(`Cannot resolve recipe placeholder {config.${key}} without configured ${key}.`);
            }

            return replacement;
        })
        .replace(AUTH_PLACEHOLDER_PATTERN, (_match, plainKey: string | undefined, encodedKey: string | undefined) => {
            const key = plainKey ?? encodedKey;
            if (key === 'wsTicket') {
                if (!options.wsTicket?.ticket) {
                    throw new Error('Cannot resolve recipe placeholder {auth.wsTicket} without a websocket ticket.');
                }

                return options.wsTicket.ticket;
            }

            if (!options.session) {
                throw new Error(`Cannot resolve recipe placeholder {auth.${key}} without a logged-in Rallar session.`);
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
        });
}

function replaceCommandPlaceholders<T>(
    value: T,
    options: Readonly<{
        session?: AuthSession;
        config?: RallarBlackBoxTestConfig;
        wsTicket?: WebSocketTicketResolution;
    }>,
): T {
    if (!requiresAuthPlaceholder(value)) {
        return value;
    }

    function replace(current: unknown): unknown {
        if (typeof current === 'string') {
            return replaceCommandPlaceholdersInString(current, options);
        }

        if (Array.isArray(current)) {
            return current.map(item => replace(item));
        }

        if (!current || typeof current !== 'object') {
            return current;
        }

        return Object.fromEntries(
            Object.entries(current).map(([key, item]) => [key, replace(item)]),
        );
    }

    return replace(value) as T;
}

function responseJsonRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

async function requestWebSocketTicket(
    fetchFn: typeof fetch,
    config: RallarBlackBoxTestConfig | undefined,
    session: AuthSession | undefined,
): Promise<WebSocketTicketResolution> {
    if (!session) {
        throw new Error('Cannot request websocket ticket without a logged-in Rallar session.');
    }

    const apiBaseUrl = configApiBaseUrl(config);
    if (!apiBaseUrl) {
        throw new Error('Cannot request websocket ticket without configured apiBaseUrl.');
    }

    const response = await fetchFn(new URL('/api/auth/ws-ticket', `${apiBaseUrl}/`).toString(), {
        method: 'POST',
        headers: withRallarAuthHeaders(undefined, session),
    });
    const body = responseJsonRecord(await response.json());
    if (!response.ok) {
        throw new Error(`Websocket ticket request failed: ${response.status}`);
    }
    if (typeof body.ticket !== 'string' || body.ticket.length === 0) {
        throw new Error('Websocket ticket response did not include ticket.');
    }

    return {
        ticket: body.ticket,
        ...(typeof body.sessionId === 'string' && body.sessionId.length > 0
            ? { sessionId: body.sessionId }
            : {}),
    };
}

function shouldAttachRallarAuth(
    command: Extract<CommandWithId, { kind: 'http.request' }>,
    config: RallarBlackBoxTestConfig | undefined,
    url: string,
): boolean {
    if (command.request.path) {
        return true;
    }

    const apiBaseUrl = configApiBaseUrl(config);
    if (!apiBaseUrl) {
        return false;
    }

    return url === apiBaseUrl || url.startsWith(`${apiBaseUrl}/`);
}

function withRallarAuthHeaders(
    headers: HeadersInit | undefined,
    session: AuthSession | undefined,
): HeadersInit | undefined {
    if (!session) {
        return headers;
    }

    const next = new Headers(headers);
    next.set('authorization', `Bearer ${session.accessToken}`);
    next.set('x-client-id', session.clientId);
    return toHeadersRecord(next);
}

function trimTextBody(body: string, limit: number): string {
    return body.length > limit ? body.slice(0, limit) : body;
}

async function readHttpBody(
    response: Response,
    responseOptions: HttpResponseOptions | undefined,
    defaultLimit: number,
): Promise<unknown> {
    const bodyMode = responseOptions?.body ?? 'text';
    if (bodyMode === 'none') {
        return undefined;
    }

    if (bodyMode === 'json') {
        return await response.json();
    }

    return trimTextBody(
        await response.text(),
        responseOptions?.maxBodyChars ?? defaultLimit,
    );
}

function toRequestUrl(
    request: RallarBlackBoxTestCommand & { kind: 'http.request' },
    config: RallarBlackBoxTestConfig | undefined,
    session: AuthSession | undefined,
): string {
    const requestUrl = replaceCommandPlaceholders(request.request.url, { config, session });
    if (request.request.url) {
        return requestUrl ?? request.request.url;
    }

    if (!request.request.path) {
        throw new Error('http.request requires request.url or request.path.');
    }

    const apiBaseUrl = configApiBaseUrl(config);
    if (!apiBaseUrl) {
        throw new Error('http.request path requires configured apiBaseUrl.');
    }

    const path = replaceCommandPlaceholders(request.request.path, { config, session });
    return new URL(path, `${apiBaseUrl}/`).toString();
}

function addWebSocketListener(
    socket: RallarBlackBoxBrowserWebSocket,
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void,
): () => void {
    if (socket.addEventListener && socket.removeEventListener) {
        socket.addEventListener(type, listener);
        return () => socket.removeEventListener?.(type, listener);
    }

    const property = `on${type}` as keyof Pick<
        RallarBlackBoxBrowserWebSocket,
        'onopen' | 'onmessage' | 'onclose' | 'onerror'
    >;
    const previous = socket[property];
    const next = (event: unknown) => {
        previous?.(event);
        listener(event);
    };

    socket[property] = next;
    return () => {
        if (socket[property] === next) {
            socket[property] = previous;
        }
    };
}

function toWebSocketSendData(data: unknown): unknown {
    if (
        typeof data === 'string' ||
        data instanceof ArrayBuffer ||
        ArrayBuffer.isView(data)
    ) {
        return data;
    }

    return JSON.stringify(data);
}

function toWebSocketMessageData(event: unknown): unknown {
    if (event && typeof event === 'object' && 'data' in event) {
        return (event as { data: unknown }).data;
    }

    return undefined;
}

function toWebSocketClosePayload(event: unknown): Record<string, unknown> {
    const closeEvent = asRecord(event);
    return {
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
    };
}

function redactedWebSocketUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.searchParams.has('ticket')) {
            url.searchParams.set('ticket', '<redacted>');
        }
        return url.toString();
    } catch {
        return value.replace(/([?&]ticket=)[^&]+/i, '$1<redacted>');
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toRallarBrowserEventInput(
    event: RallarBlackBoxBrowserRallarEvent,
): RallarBlackBoxTestRuntimeEventInput {
    const kind = event.kind === 'message'
        ? 'message'
        : event.kind === 'close'
            ? 'event'
            : 'diagnostic';

    const payload = {
        roomId: event.roomId,
        roomRef: event.roomRef,
        scope: event.scope,
        applicationId: event.applicationId,
        workspaceId: event.workspaceId,
        laneId: event.laneId,
        peerId: event.peerId,
        remotePeerId: event.remotePeerId,
        senderId: event.senderId,
        typeId: event.typeId,
        topicId: event.topicId,
        contextId: event.contextId,
        resourceId: event.resourceId,
        data: event.data,
        error: event.error,
    };
    const severity = inferRallarBlackBoxDiagnosticSeverity({
        topic: event.topic ?? 'rallar.browser.event',
        severity: event.severity,
        error: event.error,
        data: event.data,
        payload,
    });

    return {
        kind,
        topic: event.topic ?? 'rallar.browser.event',
        connection: event.connection,
        actor: event.actor,
        transport: toEventTransport(event.transport),
        severity: event.kind === 'message'
            ? 'info'
            : event.kind === 'close'
                ? 'warning'
                : severity,
        payload: kind === 'diagnostic'
            ? normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: event.topic ?? 'rallar.browser.event',
                severity,
                transport: toEventTransport(event.transport),
                connection: event.connection,
                actor: event.actor,
                roomId: event.roomId,
                laneId: event.laneId,
                peerId: event.peerId,
                remotePeerId: event.remotePeerId,
                senderId: event.senderId,
                typeId: event.typeId,
                topicId: event.topicId,
                contextId: event.contextId,
                resourceId: event.resourceId,
                atEpochMs: event.atEpochMs,
                data: event.data,
                error: event.error,
                payload,
                source: 'browser-rallar-runtime',
            })
            : payload,
    };
}

class BrowserCommandAdapter {
    private readonly rallarRuntime: RallarBlackBoxBrowserRallarRuntime | undefined;
    private readonly fetchFn: typeof fetch | undefined;
    private readonly webSocketFactory: RallarBlackBoxBrowserWebSocketFactory | undefined;
    private readonly defaultWsOpenTimeoutMs: number;
    private readonly defaultHttpBodyLimit: number;
    private readonly webSockets = new Map<string, RallarBlackBoxBrowserWebSocket>();
    private readonly webSocketDisposers = new Map<string, Array<() => void>>();

    constructor(options: CreateRallarBlackBoxBrowserTestRuntimeOptions) {
        this.rallarRuntime = options.rallarRuntime;
        this.fetchFn = options.fetch ?? globalThis.fetch?.bind(globalThis);
        this.webSocketFactory = options.webSocketFactory ?? this.defaultWebSocketFactory();
        this.defaultWsOpenTimeoutMs = options.defaultWsOpenTimeoutMs ??
            DEFAULT_WS_OPEN_TIMEOUT_MS;
        this.defaultHttpBodyLimit = options.defaultHttpBodyLimit ??
            DEFAULT_HTTP_BODY_LIMIT;
    }

    async execute(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        const delayMs = commandLocalDelayMs(command);
        if (delayMs > 0) {
            await sleep(delayMs, context.abortSignal?.());
        }

        switch (command.kind) {
            case 'rtc.connect':
                return await this.connectRtc(command, context);
            case 'rtc.send':
                return await this.sendRtc(command, context);
            case 'rtc.stream':
                return await this.streamRtc(command, context);
            case 'ws.open':
                return await this.openWebSocket(command, context);
            case 'ws.send':
                return await this.sendWebSocket(command, context);
            case 'ws.close':
                return this.closeWebSocket(command);
            case 'http.request':
                return await this.httpRequest(command, context);
            case 'crdt.open':
                return await this.executeCrdt(command, context, 'open', 'rallar.bb.crdt.opened');
            case 'crdt.apply':
                return await this.executeCrdt(command, context, 'apply', 'rallar.bb.crdt.applied');
            case 'crdt.read':
                return await this.executeCrdt(command, context, 'read', 'rallar.bb.crdt.read');
            case 'crdt.sync':
                return await this.executeCrdt(command, context, 'sync', 'rallar.bb.crdt.synced');
            case 'crdt.health':
                return await this.executeCrdt(command, context, 'health', 'rallar.bb.crdt.health');
            case 'crdt.wait':
                return await this.executeCrdt(command, context, 'wait', 'rallar.bb.crdt.wait_matched');
            case 'crdt.undo':
                return await this.executeCrdt(command, context, 'undo', 'rallar.bb.crdt.undone');
            case 'crdt.redo':
                return await this.executeCrdt(command, context, 'redo', 'rallar.bb.crdt.redone');
            case 'crdt.close':
                return await this.executeCrdt(command, context, 'close', 'rallar.bb.crdt.closed');
            case 'crdt.destroy':
                return await this.executeCrdt(command, context, 'destroy', 'rallar.bb.crdt.destroyed');
            case 'director.appoint':
                return await this.executeDirector(command, context, 'appoint', 'rallar.bb.director.appointed');
            case 'director.resign':
                return await this.executeDirector(command, context, 'resign', 'rallar.bb.director.resigned');
            case 'director.status':
                return await this.executeDirector(command, context, 'status', 'rallar.bb.director.status');
            case 'director.relay.start':
                return await this.executeDirector(command, context, 'relayStart', 'rallar.bb.director.relay_started');
            case 'director.intent':
                return await this.executeDirector(command, context, 'intent', 'rallar.bb.director.intent_sent');
            case 'director.sync.request':
                return await this.executeDirector(command, context, 'syncRequest', 'rallar.bb.director.sync_requested');
            case 'director.relay.stop':
                return await this.executeDirector(command, context, 'relayStop', 'rallar.bb.director.relay_stopped');
            case 'health':
                return await this.health(command, context);
            case 'close':
                return await this.close(command, context);
            case 'reset':
                return await this.reset();
            default:
                return undefined;
        }
    }

    async cleanupOwnedResources(
        input: RallarBlackBoxTestCleanupInput,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<void> {
        const value = await this.closeOwnedResources({
            rallar: true,
            tolerant: true,
        });
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.cleanup.resources_closed',
            commandId: input.commandId,
            severity: 'info',
            payload: {
                ...input,
                ...value,
            },
        });
    }

    private defaultWebSocketFactory(): RallarBlackBoxBrowserWebSocketFactory | undefined {
        const WebSocketConstructor = globalThis.WebSocket;
        if (!WebSocketConstructor) {
            return undefined;
        }

        return (url, protocols) => new WebSocketConstructor(
            url,
            protocols as string | string[] | undefined,
        ) as RallarBlackBoxBrowserWebSocket;
    }

    private requireRallarRuntime(): RallarBlackBoxBrowserRallarRuntime {
        if (!this.rallarRuntime) {
            throw new Error('Rallar browser runtime is not configured.');
        }

        return this.rallarRuntime;
    }

    private toRallarAuthConnectionConfig(
        config: RallarBlackBoxTestConfig | undefined,
    ): RallarBlackBoxBrowserRallarConnectionConfig {
        const configuredRallar = asRecord(config?.rallar);
        const defaults = asRecord(config?.defaults);
        const apiBaseUrl = firstDefined(
            configuredRallar.apiBaseUrl,
            config?.apiBaseUrl,
        );
        const expectedSessionId = firstDefined(
            configuredRallar.expectedSessionId,
            configuredRallar.sessionId,
            config?.sessionId,
        );

        return {
            connection: toStringValue(defaults.connection) ??
                config?.actor ??
                'default',
            actor: config?.actor,
            rallar: {
                ...configuredRallar,
                ...(apiBaseUrl ? { apiBaseUrl } : {}),
                ...(expectedSessionId ? { expectedSessionId } : {}),
                transport: 'realtime',
            },
        };
    }

    private async sessionForRallarAuth(
        value: unknown,
        config: RallarBlackBoxTestConfig | undefined,
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        options: Readonly<{ required?: boolean }> = {},
    ): Promise<AuthSession | undefined> {
        let session = readOptionalBrowserSession();
        const needsSession = options.required === true ||
            requiresAuthSessionPlaceholder(value);
        if (session || !needsSession || !this.rallarRuntime) {
            return session;
        }

        const abort = this.commandAbortSignal(command, context);
        try {
            await this.withAbort(
                this.rallarRuntime.connect(this.toRallarAuthConnectionConfig(config)),
                abort.signal,
            );
        } finally {
            abort.cleanup();
        }

        session = readOptionalBrowserSession();
        return session;
    }

    private requireRallarCrdtRuntime(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
    ): RallarBlackBoxBrowserRallarCrdtRuntime {
        const crdt = this.rallarRuntime?.crdt;
        if (crdt) {
            return crdt;
        }

        const message = 'Browser Rallar runtime does not support CRDT commands.';
        const payload = normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.bb.crdt.failed',
            severity: 'error',
            commandId: command.commandId,
            message,
            data: {
                kind: command.kind,
                handle: asRecord(command).handle,
                reason: 'unsupported-runtime',
            },
            payload: {
                kind: command.kind,
                handle: asRecord(command).handle,
                reason: 'unsupported-runtime',
            },
            source: 'browser-adapter',
        });
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.crdt.failed',
            commandId: command.commandId,
            severity: 'error',
            payload,
        });
        throw new Error(message);
    }

    private requireRallarDirectorRuntime(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
    ): RallarBlackBoxBrowserRallarDirectorRuntime {
        const director = this.rallarRuntime?.director;
        if (director) {
            return director;
        }

        const message = 'Browser Rallar runtime does not support director commands.';
        const payload = normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.bb.director.failed',
            severity: 'error',
            commandId: command.commandId,
            message,
            data: {
                kind: command.kind,
                handle: asRecord(command).handle,
                reason: 'unsupported-runtime',
            },
            payload: {
                kind: command.kind,
                handle: asRecord(command).handle,
                reason: 'unsupported-runtime',
            },
            source: 'browser-adapter',
        });
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.director.failed',
            commandId: command.commandId,
            severity: 'error',
            payload,
        });
        throw new Error(message);
    }

    private requireFetch(): typeof fetch {
        if (!this.fetchFn) {
            throw new Error('fetch is not available for http.request.');
        }

        return this.fetchFn;
    }

    private requireWebSocketFactory(): RallarBlackBoxBrowserWebSocketFactory {
        if (!this.webSocketFactory) {
            throw new Error('WebSocket is not available for ws commands.');
        }

        return this.webSocketFactory;
    }

    private commandAbortSignal(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
    ): { signal?: AbortSignal; cleanup(): void } {
        const parentSignal = context.abortSignal?.();
        const timeoutMs = command.timeoutMs !== undefined
            ? Math.max(0, command.timeoutMs)
            : command.deadlineEpochMs !== undefined
                ? Math.max(0, command.deadlineEpochMs - Date.now())
                : undefined;
        if (!parentSignal && timeoutMs === undefined) {
            return {
                cleanup: () => undefined,
            };
        }

        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const abortFromParent = () => {
            if (!controller.signal.aborted) {
                controller.abort(parentSignal?.reason ?? 'Rallar black-box command was cancelled.');
            }
        };
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            parentSignal?.removeEventListener('abort', abortFromParent);
        };

        if (parentSignal?.aborted) {
            abortFromParent();
        } else {
            parentSignal?.addEventListener('abort', abortFromParent, {
                once: true,
            });
        }

        if (timeoutMs !== undefined) {
            timeout = setTimeout(() => {
                if (!controller.signal.aborted) {
                    controller.abort(toTimeoutError());
                }
            }, timeoutMs);
        }

        return {
            signal: controller.signal,
            cleanup,
        };
    }

    private async withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
        if (!signal) {
            return await promise;
        }
        if (signal.aborted) {
            throw toAbortError(signal.reason);
        }

        return await new Promise<T>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                signal.removeEventListener('abort', abort);
            };
            const complete = (callback: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                callback();
            };
            const abort = () => complete(() => reject(toAbortError(signal.reason)));

            signal.addEventListener('abort', abort, {
                once: true,
            });
            promise.then(
                value => complete(() => resolve(value)),
                error => complete(() => reject(error)),
            );
        });
    }

    private toRallarConnectionConfig(
        command: Extract<CommandWithId, { kind: 'rtc.connect' }>,
        config: RallarBlackBoxTestConfig | undefined,
    ): RallarBlackBoxBrowserRallarConnectionConfig {
        const configuredRallar = asRecord(config?.rallar);
        const commandRallar = asRecord(command.rallar);
        const transport = command.transport ??
            toRtcTransport(firstDefined(commandRallar.transport, config?.transport));
        const apiBaseUrl = firstDefined(
            commandRallar.apiBaseUrl,
            configuredRallar.apiBaseUrl,
            config?.apiBaseUrl,
        );
        const expectedSessionId = firstDefined(
            commandRallar.expectedSessionId,
            commandRallar.sessionId,
            configuredRallar.expectedSessionId,
            configuredRallar.sessionId,
            config?.sessionId,
        );
        const rallar = {
            ...configuredRallar,
            ...commandRallar,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            ...(transport ? { transport } : {}),
            ...(expectedSessionId ? { expectedSessionId } : {}),
            ...(command.applicationId !== undefined
                ? { applicationId: command.applicationId }
                : {}),
            ...(command.workspaceId !== undefined
                ? { workspaceId: command.workspaceId }
                : {}),
            ...(command.scope !== undefined ? { scope: command.scope } : {}),
            ...(command.roomRef !== undefined ? { roomRef: command.roomRef } : {}),
            ...(command.minSnapshotVersion !== undefined
                ? { minSnapshotVersion: command.minSnapshotVersion }
                : {}),
        };

        return {
            connection: command.connection ??
                toStringValue(asRecord(config?.defaults).connection) ??
                config?.actor ??
                'default',
            actor: command.actor ?? config?.actor,
            roomId: command.roomId ?? config?.roomId,
            roomRef: command.roomRef,
            rallar,
        };
    }

    private toRallarWebSocketConnectionConfig(
        command: Extract<CommandWithId, { kind: 'ws.send' }>,
        config: RallarBlackBoxTestConfig | undefined,
    ): RallarBlackBoxBrowserRallarConnectionConfig {
        const configuredRallar = asRecord(config?.rallar);
        const data = asRecord(command.data);
        const dataScope = optionalRecord(data.scope);
        const configuredScope = optionalRecord(configuredRallar.scope);
        const applicationId = nonEmptyStringValue(firstDefined(
            data.applicationId,
            dataScope?.applicationId,
            configuredRallar.applicationId,
            configuredScope?.applicationId,
        ));
        const workspaceId = nonEmptyStringValue(firstDefined(
            data.workspaceId,
            dataScope?.workspaceId,
            configuredRallar.workspaceId,
            configuredScope?.workspaceId,
        ));
        const stateScope = applicationId
            ? {
                applicationId,
                ...(workspaceId ? { workspaceId } : {}),
            }
            : configuredScope;
        const wsScope = wsScopeValue(data.scope);
        const roomIdCandidate = nonEmptyStringValue(firstDefined(
            data.roomId,
            data.groupId,
            config?.roomId,
        ));
        const roomId = wsScope === 'all' || wsScope === 'world'
            ? undefined
            : roomIdCandidate;
        const configuredRoomRef = optionalRecord(configuredRallar.roomRef);
        const dataRoomRef = optionalRecord(data.roomRef);
        const roomRef = roomId
            ? dataRoomRef ??
                configuredRoomRef ??
                (applicationId
                    ? {
                        applicationId,
                        ...(workspaceId ? { workspaceId } : {}),
                        groupId: roomId,
                    }
                    : undefined)
            : undefined;
        const apiBaseUrl = nonEmptyStringValue(firstDefined(
            configuredRallar.apiBaseUrl,
            config?.apiBaseUrl,
        ));
        const expectedSessionId = nonEmptyStringValue(firstDefined(
            configuredRallar.expectedSessionId,
            configuredRallar.sessionId,
            config?.sessionId,
        ));
        const typeId = nonEmptyStringValue(data.typeId);
        const topicId = nonEmptyStringValue(data.topicId);
        const rallar = {
            ...configuredRallar,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            transport: 'realtime',
            restoreSession: configuredRallar.restoreSession ?? true,
            ...(expectedSessionId ? { expectedSessionId } : {}),
            ...(applicationId ? { applicationId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(stateScope ? { scope: stateScope } : {}),
            ...(roomRef ? { roomRef } : {}),
            ...(typeId ? { typeId } : {}),
            ...(topicId ? { topicId } : {}),
        };

        return {
            connection: command.connection ??
                toStringValue(asRecord(config?.defaults).connection) ??
                config?.actor ??
                'default',
            actor: config?.actor,
            ...(roomId ? { roomId } : {}),
            ...(roomRef ? { roomRef } : {}),
            rallar,
        };
    }

    private toCrdtRuntimeInput(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
    ): Record<string, unknown> {
        const resolved = replaceCommandPlaceholders(command, {
            config: context.config(),
            session: readOptionalBrowserSession(),
        }) as Record<string, unknown>;

        if (command.kind === 'crdt.open' && resolved.handle === undefined) {
            const configuredRallar = asRecord(context.config()?.rallar);
            return {
                ...resolved,
                handle: command.commandId,
                apiBaseUrl: resolved.apiBaseUrl ?? context.config()?.apiBaseUrl ?? configuredRallar.apiBaseUrl,
                actor: resolved.actor ?? context.config()?.actor,
                sessionId: resolved.sessionId ?? context.config()?.sessionId ?? configuredRallar.sessionId,
                roomId: resolved.roomId ?? context.config()?.roomId,
                rallar: {
                    ...configuredRallar,
                    ...asRecord(resolved.rallar),
                },
            };
        }

        if (command.kind === 'crdt.open') {
            const configuredRallar = asRecord(context.config()?.rallar);
            return {
                ...resolved,
                apiBaseUrl: resolved.apiBaseUrl ?? context.config()?.apiBaseUrl ?? configuredRallar.apiBaseUrl,
                actor: resolved.actor ?? context.config()?.actor,
                sessionId: resolved.sessionId ?? context.config()?.sessionId ?? configuredRallar.sessionId,
                roomId: resolved.roomId ?? context.config()?.roomId,
                rallar: {
                    ...configuredRallar,
                    ...asRecord(resolved.rallar),
                },
            };
        }

        return resolved;
    }

    private toDirectorRuntimeInput(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
    ): Record<string, unknown> {
        const resolved = replaceCommandPlaceholders(command, {
            config: context.config(),
            session: readOptionalBrowserSession(),
        }) as Record<string, unknown>;
        const config = context.config();
        const configuredRallar = asRecord(config?.rallar);
        const defaults = asRecord(config?.defaults);
        const roomId = resolved.roomId ?? config?.roomId ?? defaults.groupId;
        const applicationId = resolved.applicationId ??
            configuredRallar.applicationId ??
            defaults.applicationId;
        const workspaceId = resolved.workspaceId ??
            configuredRallar.workspaceId ??
            defaults.workspaceId;

        return {
            ...resolved,
            ...(roomId !== undefined ? { roomId } : {}),
            ...(applicationId !== undefined ? { applicationId } : {}),
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            actor: resolved.actor ?? config?.actor,
            sessionId: resolved.sessionId ?? config?.sessionId ?? configuredRallar.sessionId,
            rallar: {
                ...configuredRallar,
                ...asRecord(resolved.rallar),
            },
        };
    }

    private async executeCrdt(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        method: RallarBlackBoxBrowserRallarCrdtMethod,
        successTopic: string,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const crdt = this.requireRallarCrdtRuntime(command, context);
        const input = this.toCrdtRuntimeInput(command, context);
        const abort = this.commandAbortSignal(command, context);
        let value: unknown;
        if (method === 'wait') {
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.crdt.waiting',
                commandId: command.commandId,
                severity: 'info',
                payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                    topic: 'rallar.bb.crdt.waiting',
                    severity: 'info',
                    commandId: command.commandId,
                    data: {
                        method,
                        kind: command.kind,
                        handle: input.handle,
                        conditions: input.conditions,
                        timeoutMs: input.timeoutMs,
                        intervalMs: input.intervalMs,
                        stableForMs: input.stableForMs,
                    },
                    payload: {
                        method,
                        kind: command.kind,
                        handle: input.handle,
                        conditions: input.conditions,
                        timeoutMs: input.timeoutMs,
                        intervalMs: input.intervalMs,
                        stableForMs: input.stableForMs,
                    },
                    source: 'browser-adapter',
                }),
            });
        }
        try {
            value = await this.withAbort(crdt[method](input), abort.signal);
        } catch (error) {
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.crdt.failed',
                commandId: command.commandId,
                severity: 'error',
                payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                    topic: 'rallar.bb.crdt.failed',
                    severity: 'error',
                    commandId: command.commandId,
                    message: error instanceof Error ? error.message : String(error),
                    data: {
                        method,
                        kind: command.kind,
                        handle: input.handle,
                    },
                    payload: {
                        method,
                        kind: command.kind,
                        handle: input.handle,
                    },
                    error,
                    source: 'browser-adapter',
                }),
            });
            throw error;
        } finally {
            abort.cleanup();
        }

        context.recordEvent({
            kind: 'diagnostic',
            topic: successTopic,
            commandId: command.commandId,
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: successTopic,
                severity: 'info',
                commandId: command.commandId,
                data: value,
                payload: value,
                source: 'browser-adapter',
            }),
        });

        return {
            status: 'ok',
            value,
            nextStatus: context.state().status,
        };
    }

    private async executeDirector(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        method: RallarBlackBoxBrowserRallarDirectorMethod,
        successTopic: string,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const director = this.requireRallarDirectorRuntime(command, context);
        const input = this.toDirectorRuntimeInput(command, context);
        const abort = this.commandAbortSignal(command, context);
        let value: unknown;
        try {
            value = await this.withAbort(director[method](input), abort.signal);
        } catch (error) {
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.director.failed',
                commandId: command.commandId,
                severity: 'error',
                payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                    topic: 'rallar.bb.director.failed',
                    severity: 'error',
                    commandId: command.commandId,
                    message: error instanceof Error ? error.message : String(error),
                    data: {
                        method,
                        kind: command.kind,
                        handle: input.handle,
                    },
                    payload: {
                        method,
                        kind: command.kind,
                        handle: input.handle,
                    },
                    error,
                    source: 'browser-adapter',
                }),
            });
            throw error;
        } finally {
            abort.cleanup();
        }

        context.recordEvent({
            kind: 'diagnostic',
            topic: successTopic,
            commandId: command.commandId,
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: successTopic,
                severity: 'info',
                commandId: command.commandId,
                data: value,
                payload: value,
                source: 'browser-adapter',
            }),
        });

        return {
            status: 'ok',
            value,
            nextStatus: context.state().status,
        };
    }

    private rtcConnectReadinessOptions(
        command: Extract<CommandWithId, { kind: 'rtc.connect' }>,
    ): RtcConnectReadinessOptions | undefined {
        if (!command.readiness) {
            return undefined;
        }

        return {
            minReadyPeers: toPositiveInteger(command.readiness.minReadyPeers, 1),
            timeoutMs: toPositiveInteger(command.readiness.timeoutMs, 5_000),
            intervalMs: toPositiveInteger(command.readiness.intervalMs, 100),
        };
    }

    private recordRtcReadinessDiagnostic(
        context: RallarBlackBoxTestCommandContext,
        command: Extract<CommandWithId, { kind: 'rtc.connect' }>,
        topic: string,
        severity: 'info' | 'error',
        payload: Readonly<Record<string, unknown>>,
    ): void {
        context.recordEvent({
            kind: 'diagnostic',
            topic,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity,
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic,
                severity,
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: payload,
                payload,
                message: typeof payload.message === 'string'
                    ? payload.message
                    : undefined,
                source: 'browser-adapter',
            }),
        });
    }

    private async waitForRtcConnectReadiness(
        command: Extract<CommandWithId, { kind: 'rtc.connect' }>,
        context: RallarBlackBoxTestCommandContext,
        options: RtcConnectReadinessOptions,
        signal?: AbortSignal,
    ): Promise<RtcConnectReadinessResult> {
        const startedAtEpochMs = Date.now();
        this.recordRtcReadinessDiagnostic(context, command, 'rallar.bb.rtc.readiness_wait_started', 'info', {
            minReadyPeers: options.minReadyPeers,
            timeoutMs: options.timeoutMs,
            intervalMs: options.intervalMs,
        });

        let latestHealth: unknown;
        let readyPeerIds: readonly string[] = [];
        while (true) {
            latestHealth = await this.requireRallarRuntime().health();
            readyPeerIds = toRtcReadyPeerIds(latestHealth);
            const waitedMs = Math.max(0, Date.now() - startedAtEpochMs);
            if (readyPeerIds.length >= options.minReadyPeers) {
                const result: RtcConnectReadinessResult = {
                    ready: true,
                    minReadyPeers: options.minReadyPeers,
                    timeoutMs: options.timeoutMs,
                    intervalMs: options.intervalMs,
                    waitedMs,
                    readyPeerIds,
                    health: latestHealth,
                };
                this.recordRtcReadinessDiagnostic(context, command, 'rallar.bb.rtc.readiness_ready', 'info', {
                    ...result,
                });
                return result;
            }

            if (waitedMs >= options.timeoutMs) {
                const result: RtcConnectReadinessResult = {
                    ready: false,
                    minReadyPeers: options.minReadyPeers,
                    timeoutMs: options.timeoutMs,
                    intervalMs: options.intervalMs,
                    waitedMs,
                    readyPeerIds,
                    health: latestHealth,
                };
                this.recordRtcReadinessDiagnostic(context, command, 'rallar.bb.rtc.readiness_timeout', 'error', {
                    ...result,
                    message: 'RTC connect timed out waiting for ready peers.',
                });
                return result;
            }

            await sleep(Math.min(options.intervalMs, Math.max(1, options.timeoutMs - waitedMs)), signal);
        }
    }

    private async connectRtc(
        command: Extract<CommandWithId, { kind: 'rtc.connect' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const connectionConfig = this.toRallarConnectionConfig(
            replaceCommandPlaceholders(command, {
                config: context.config(),
                session: readOptionalBrowserSession(),
            }),
            context.config(),
        );
        let diagnostics: unknown;
        let readiness: RtcConnectReadinessResult | undefined;
        const connectAbort = this.commandAbortSignal(command, context);
        try {
            diagnostics = await this.withAbort(
                this.requireRallarRuntime().connect(connectionConfig),
                connectAbort.signal,
            );
        } finally {
            connectAbort.cleanup();
        }
        const readinessOptions = this.rtcConnectReadinessOptions(command);
        if (readinessOptions) {
            readiness = await this.waitForRtcConnectReadiness(
                command,
                context,
                readinessOptions,
                context.abortSignal?.(),
            );
            if (!readiness.ready) {
                return {
                    status: 'failed',
                    value: withRtcConnectReadinessValue(diagnostics, readiness),
                    error: {
                        code: 'RALLAR_BB_RTC_READY_TIMEOUT',
                        message: 'RTC connect timed out waiting for ready peers.',
                        details: readiness,
                    },
                    nextStatus: 'failed',
                };
            }
        }
        const value = readiness
            ? withRtcConnectReadinessValue(diagnostics, readiness)
            : diagnostics;
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.rtc.connected',
            commandId: command.commandId,
            connection: connectionConfig.connection,
            actor: connectionConfig.actor,
            transport: toRtcTransport(connectionConfig.rallar.transport),
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: 'rallar.bb.rtc.connected',
                severity: 'info',
                commandId: command.commandId,
                connection: connectionConfig.connection,
                actor: connectionConfig.actor,
                transport: toRtcTransport(connectionConfig.rallar.transport),
                roomId: connectionConfig.roomId,
                data: value,
                payload: value,
                source: 'browser-adapter',
            }),
        });

        return {
            status: 'ok',
            value,
            nextStatus: context.state().status === 'idle'
                ? 'configured'
                : context.state().status,
        };
    }

    private async sendRtc(
        command: Extract<CommandWithId, { kind: 'rtc.send' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const resolvedSend = replaceCommandPlaceholders(command.send ?? {}, {
            config: context.config(),
            session: readOptionalBrowserSession(),
        });
        const scopedSendFields = Object.fromEntries(
            Object.entries({
                applicationId: command.applicationId,
                workspaceId: command.workspaceId,
                scope: command.scope,
                roomRef: command.roomRef,
                minSnapshotVersion: command.minSnapshotVersion,
            }).filter(([_key, value]) => value !== undefined),
        );
        let scopedSend: unknown = resolvedSend;
        if (Object.keys(scopedSendFields).length > 0) {
            scopedSend = resolvedSend && typeof resolvedSend === 'object' && !Array.isArray(resolvedSend)
                ? {
                    ...(resolvedSend as Record<string, unknown>),
                    ...Object.fromEntries(
                        Object.entries(scopedSendFields).filter(([key]) =>
                            !Object.prototype.hasOwnProperty.call(resolvedSend, key)
                        ),
                    ),
                }
                : {
                    data: resolvedSend,
                    ...scopedSendFields,
                };
        }
        if (requiresRtcReadyPeerPlaceholder(scopedSend)) {
            const health = await this.requireRallarRuntime().health();
            scopedSend = replaceRtcReadyPeerPlaceholders(scopedSend, toRtcReadyPeerIds(health));
        }
        const abort = this.commandAbortSignal(command, context);
        let diagnostics: unknown;
        const sendStartedAtEpochMs = Date.now();
        try {
            diagnostics = await this.withAbort(
                this.requireRallarRuntime().send(scopedSend),
                abort.signal,
            );
        } finally {
            abort.cleanup();
        }
        const failure = rtcSendFailureFromDiagnostics(diagnostics);
        const sendObservation = rtcSendObservation(
            command,
            diagnostics,
            Math.max(0, Date.now() - sendStartedAtEpochMs),
            failure === undefined,
            failure?.code,
        );
        context.recordEvent({
            kind: 'diagnostic',
            topic: failure ? 'rallar.bb.rtc.send_failed' : 'rallar.bb.rtc.send_completed',
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: failure ? 'error' : 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: failure ? 'rallar.bb.rtc.send_failed' : 'rallar.bb.rtc.send_completed',
                severity: failure ? 'error' : 'info',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: diagnostics,
                payload: failure
                    ? {
                    diagnostics,
                    failure,
                    sendObservation,
                }
                    : withSendObservationValue(diagnostics, sendObservation),
                message: failure?.message,
                error: failure,
                source: 'browser-adapter',
            }),
        });

        if (failure) {
            return {
                status: 'failed',
                value: withSendObservationValue(diagnostics, sendObservation),
                error: {
                    code: failure.code,
                    message: failure.message,
                    details: failure.details,
                },
                nextStatus: 'failed',
            };
        }

        return {
            status: 'ok',
            value: withSendObservationValue(diagnostics, sendObservation),
            nextStatus: context.state().status,
        };
    }

    private async streamRtc(
        command: Extract<CommandWithId, { kind: 'rtc.stream' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const plan = planRallarBlackBoxRtcStreamFrames({
            count: command.count,
            durationMs: command.durationMs,
            intervalMs: command.intervalMs,
            rateHz: command.rateHz,
        });
        const rallarRuntime = this.requireRallarRuntime();
        const abort = this.commandAbortSignal(command, context);
        const streamStartedAtEpochMs = Date.now();
        const maxInFlight = toPositiveInteger(command.maxInFlight, 64);
        const drainTimeoutMs = typeof command.drainTimeoutMs === 'number' && command.drainTimeoutMs >= 0
            ? command.drainTimeoutMs
            : 5_000;
        const progressEveryMs = toPositiveInteger(command.progressEveryMs, 1_000);
        const sampleEvery = toPositiveInteger(command.sampleEvery, 1);
        const observations: RallarBlackBoxTestRtcStreamFrameObservation[] = [];
        const active = new Map<string, Readonly<{
            commandId: string;
            index: number;
            iteration: number;
            scheduledAtEpochMs: number;
            startedAtEpochMs: number;
        }>>();
        const inFlight = new Set<Promise<void>>();
        let lastProgressAtEpochMs = streamStartedAtEpochMs;

        const recordProgress = (force = false): void => {
            const now = Date.now();
            if (!force && now - lastProgressAtEpochMs < progressEveryMs) {
                return;
            }
            lastProgressAtEpochMs = now;
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.rtc.stream_progress',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                severity: 'info',
                payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                    topic: 'rallar.bb.rtc.stream_progress',
                    severity: 'info',
                    commandId: command.commandId,
                    connection: command.connection,
                    transport: command.transport,
                    data: {
                        plannedFrames: plan.frames.length,
                        scheduledFrames: observations.length + active.size,
                        completedFrames: observations.filter(observation => observation.ok && !observation.dropped).length,
                        failedFrames: observations.filter(observation => !observation.ok).length,
                        droppedFrames: observations.filter(observation => observation.dropped).length,
                        inFlightFrames: active.size,
                    },
                    source: 'browser-adapter',
                }),
            });
        };

        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.rtc.stream_started',
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: 'rallar.bb.rtc.stream_started',
                severity: 'info',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: {
                    plannedFrames: plan.frames.length,
                    intervalMs: plan.intervalMs,
                    requestedRateHz: plan.requestedRateHz,
                    maxInFlight,
                    drainTimeoutMs,
                },
                source: 'browser-adapter',
            }),
        });

        try {
            for (const frame of plan.frames) {
                const scheduledAtEpochMs = streamStartedAtEpochMs + frame.scheduledElapsedMs;
                const delayMs = Math.max(0, scheduledAtEpochMs - Date.now());
                if (delayMs > 0) {
                    await sleep(delayMs, abort.signal);
                }

                const startedAtEpochMs = Date.now();
                const frameCommandId = `${command.commandId}:f${frame.iteration}`;
                if (active.size >= maxInFlight) {
                    observations.push({
                        commandId: frameCommandId,
                        index: frame.index,
                        iteration: frame.iteration,
                        scheduledAtEpochMs,
                        startedAtEpochMs,
                        completedAtEpochMs: startedAtEpochMs,
                        startDriftMs: Math.max(0, startedAtEpochMs - scheduledAtEpochMs),
                        durationMs: 0,
                        ok: false,
                        dropped: true,
                        status: 'dropped',
                        errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT',
                    });
                    recordProgress();
                    continue;
                }

                const scopedSend = this.toScopedRtcStreamSend(command, context, {
                    commandId: frameCommandId,
                    index: frame.index,
                    iteration: frame.iteration,
                    elapsedMs: Math.max(0, startedAtEpochMs - streamStartedAtEpochMs),
                    scheduledElapsedMs: frame.scheduledElapsedMs,
                });
                const activeFrame = {
                    commandId: frameCommandId,
                    index: frame.index,
                    iteration: frame.iteration,
                    scheduledAtEpochMs,
                    startedAtEpochMs,
                };
                active.set(frameCommandId, activeFrame);
                const promise = (async () => {
                    try {
                        const diagnostics = await this.withAbort(
                            rallarRuntime.send(scopedSend),
                            abort.signal,
                        );
                        const completedAtEpochMs = Date.now();
                        const failure = rtcSendFailureFromDiagnostics(diagnostics);
                        observations.push(this.toRtcStreamObservation(
                            activeFrame,
                            completedAtEpochMs,
                            diagnostics,
                            failure?.code,
                            failure === undefined,
                        ));
                    } catch (error) {
                        const completedAtEpochMs = Date.now();
                        observations.push({
                            commandId: activeFrame.commandId,
                            index: activeFrame.index,
                            iteration: activeFrame.iteration,
                            scheduledAtEpochMs: activeFrame.scheduledAtEpochMs,
                            startedAtEpochMs: activeFrame.startedAtEpochMs,
                            completedAtEpochMs,
                            startDriftMs: Math.max(0, activeFrame.startedAtEpochMs - activeFrame.scheduledAtEpochMs),
                            durationMs: Math.max(0, completedAtEpochMs - activeFrame.startedAtEpochMs),
                            ok: false,
                            status: 'failed',
                            errorCode: error instanceof Error ? error.name : 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED',
                        });
                    } finally {
                        active.delete(frameCommandId);
                    }
                })();
                inFlight.add(promise);
                promise.finally(() => inFlight.delete(promise));
                recordProgress();
            }

            const drainDeadlineEpochMs = Date.now() + drainTimeoutMs;
            while (inFlight.size > 0 && Date.now() < drainDeadlineEpochMs) {
                const remainingMs = Math.max(0, drainDeadlineEpochMs - Date.now());
                await Promise.race([
                    ...inFlight,
                    sleep(Math.min(remainingMs, 25), abort.signal),
                ]);
            }
            if (active.size > 0) {
                const now = Date.now();
                for (const frame of active.values()) {
                    observations.push({
                        commandId: frame.commandId,
                        index: frame.index,
                        iteration: frame.iteration,
                        scheduledAtEpochMs: frame.scheduledAtEpochMs,
                        startedAtEpochMs: frame.startedAtEpochMs,
                        completedAtEpochMs: now,
                        startDriftMs: Math.max(0, frame.startedAtEpochMs - frame.scheduledAtEpochMs),
                        durationMs: Math.max(0, now - frame.startedAtEpochMs),
                        ok: false,
                        status: 'drain-timeout',
                        errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_DRAIN_TIMEOUT',
                    });
                }
                active.clear();
            }
        } finally {
            abort.cleanup();
        }

        recordProgress(true);
        const endedAtEpochMs = Date.now();
        const summarizedValue = summarizeRallarBlackBoxRtcStreamObservations({
            commandId: command.commandId,
            transport: command.transport,
            startedAtEpochMs: streamStartedAtEpochMs,
            endedAtEpochMs,
            intervalMs: plan.intervalMs,
            requestedRateHz: plan.requestedRateHz,
            plannedFrames: plan.frames.length,
            observations,
            thresholds: command.thresholds,
        });
        const value = {
            ...summarizedValue,
            observations: sampleRallarBlackBoxRtcStreamObservations(
                summarizedValue.observations,
                sampleEvery,
            ),
        };
        const thresholdFailed = value.thresholdFailures.length > 0;
        const sendFailed = value.failedFrames > 0 && command.continueOnSendFailure !== true;
        const failed = thresholdFailed || sendFailed;
        const topic = failed ? 'rallar.bb.rtc.stream_failed' : 'rallar.bb.rtc.stream_completed';
        const message = thresholdFailed
            ? 'RTC stream did not satisfy configured thresholds.'
            : sendFailed
                ? 'RTC stream had failed frame sends.'
                : undefined;
        const error = thresholdFailed
            ? {
                code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                message: message ?? 'RTC stream threshold failed.',
                details: {
                    thresholdFailures: value.thresholdFailures,
                    value,
                },
            }
            : sendFailed
                ? {
                    code: 'RALLAR_BLACK_BOX_RTC_STREAM_SEND_FAILED',
                    message: message ?? 'RTC stream send failed.',
                    details: {
                        failedFrames: value.failedFrames,
                        droppedFrames: value.droppedFrames,
                        value,
                    },
                }
                : undefined;

        context.recordEvent({
            kind: 'diagnostic',
            topic,
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: failed ? 'error' : 'info',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic,
                severity: failed ? 'error' : 'info',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                data: value,
                payload: value,
                message,
                error,
                source: 'browser-adapter',
            }),
        });

        return {
            status: failed ? 'failed' : 'ok',
            value,
            error,
            nextStatus: failed ? 'failed' : context.state().status,
        };
    }

    private toScopedRtcStreamSend(
        command: Extract<CommandWithId, { kind: 'rtc.stream' }>,
        context: RallarBlackBoxTestCommandContext,
        streamContext: Parameters<typeof replaceRallarBlackBoxRtcStreamPlaceholders>[1],
    ): unknown {
        const resolvedSend = replaceCommandPlaceholders(command.send, {
            config: context.config(),
            session: readOptionalBrowserSession(),
        });
        const streamSend = replaceRallarBlackBoxRtcStreamPlaceholders(resolvedSend, streamContext);
        const scopedSendFields = Object.fromEntries(
            Object.entries({
                roomId: command.roomId,
                applicationId: command.applicationId,
                workspaceId: command.workspaceId,
                scope: command.scope,
                roomRef: command.roomRef,
                minSnapshotVersion: command.minSnapshotVersion,
            }).filter(([_key, value]) => value !== undefined),
        );
        if (Object.keys(scopedSendFields).length === 0) {
            return streamSend;
        }

        return streamSend && typeof streamSend === 'object' && !Array.isArray(streamSend)
            ? {
                ...(streamSend as Record<string, unknown>),
                ...Object.fromEntries(
                    Object.entries(scopedSendFields).filter(([key]) =>
                        !Object.prototype.hasOwnProperty.call(streamSend, key)
                    ),
                ),
            }
            : {
                data: streamSend,
                ...scopedSendFields,
            };
    }

    private toRtcStreamObservation(
        frame: Readonly<{
            commandId: string;
            index: number;
            iteration: number;
            scheduledAtEpochMs: number;
            startedAtEpochMs: number;
        }>,
        completedAtEpochMs: number,
        diagnostics: unknown,
        errorCode: string | undefined,
        ok: boolean,
    ): RallarBlackBoxTestRtcStreamFrameObservation {
        const root = asRecord(diagnostics);
        const message = asRecord(root.message);
        const status = firstDefined(
            toStringValue(root.status),
            toStringValue(message.status),
        );
        return {
            commandId: frame.commandId,
            index: frame.index,
            iteration: frame.iteration,
            scheduledAtEpochMs: frame.scheduledAtEpochMs,
            startedAtEpochMs: frame.startedAtEpochMs,
            completedAtEpochMs,
            startDriftMs: Math.max(0, frame.startedAtEpochMs - frame.scheduledAtEpochMs),
            durationMs: Math.max(0, completedAtEpochMs - frame.startedAtEpochMs),
            ok,
            status,
            backpressured: status === 'backpressure' ||
                status === 'backpressured' ||
                status === 'rate-limited' ||
                status === 'buffer-full' ||
                status === 'circuit-open',
            errorCode,
        };
    }

    private async httpRequest(
        command: Extract<CommandWithId, { kind: 'http.request' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const config = context.config();
        const session = await this.sessionForRallarAuth(
            command.request,
            config,
            command,
            context,
            { required: Boolean(command.request.path) },
        );
        const wsTicket = requiresWsTicketPlaceholder(command.request)
            ? await requestWebSocketTicket(this.requireFetch(), config, session)
            : undefined;
        const resolvedRequest = replaceCommandPlaceholders(command.request, {
            config,
            session,
            wsTicket,
        });
        const resolvedCommand = {
            ...command,
            request: resolvedRequest,
        };
        const url = toRequestUrl(resolvedCommand, config, session);
        const headers = shouldAttachRallarAuth(resolvedCommand, config, url)
            ? withRallarAuthHeaders(resolvedRequest.headers, session)
            : resolvedRequest.headers;
        const abort = this.commandAbortSignal(command, context);
        let response!: Response;
        let body: unknown;
        try {
            response = await this.requireFetch()(url, {
                method: resolvedRequest.method,
                headers,
                body: resolvedRequest.body === undefined
                    ? undefined
                    : typeof resolvedRequest.body === 'string'
                        ? resolvedRequest.body
                        : JSON.stringify(resolvedRequest.body),
                credentials: resolvedRequest.credentials,
                mode: resolvedRequest.mode,
                signal: abort.signal,
            });
            const responseOptions = asRecord(command.response) as HttpResponseOptions;
            body = await readHttpBody(
                response,
                responseOptions,
                this.defaultHttpBodyLimit,
            );
        } finally {
            abort.cleanup();
        }
        const value = {
            url: response.url || url,
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            headers: toHeadersRecord(response.headers),
            body,
        };

        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.http.response',
            commandId: command.commandId,
            transport: 'http',
            severity: response.ok ? 'info' : 'warning',
            payload: value,
        });

        return {
            status: 'ok',
            value,
            nextStatus: context.state().status,
        };
    }

    private async openWebSocket(
        command: Extract<CommandWithId, { kind: 'ws.open' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const config = context.config();
        const session = await this.sessionForRallarAuth(
            command.url,
            config,
            command,
            context,
        );
        const wsTicket = requiresWsTicketPlaceholder(command.url)
            ? await requestWebSocketTicket(this.requireFetch(), config, session)
            : undefined;
        const url = command.url
            ? replaceCommandPlaceholders(command.url, {
                config,
                session,
                wsTicket,
            })
            : undefined;
        if (!url) {
            throw new Error('ws.open requires url.');
        }

        const connection = command.connection ?? 'default';
        if (this.webSockets.has(connection)) {
            throw new Error('WebSocket connection is already open: ' + connection);
        }

        if (command.headers) {
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.ws.headers_ignored',
                commandId: command.commandId,
                connection,
                transport: 'ws',
                severity: 'warning',
                payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                    topic: 'rallar.bb.ws.headers_ignored',
                    severity: 'warning',
                    commandId: command.commandId,
                    connection,
                    transport: 'ws',
                    message: 'Browser WebSocket constructors cannot set custom headers.',
                    payload: {
                    reason: 'Browser WebSocket constructors cannot set custom headers.',
                    headers: command.headers,
                },
                    source: 'browser-adapter',
                }),
            });
        }

        const socket = this.requireWebSocketFactory()(url, command.protocols);
        this.webSockets.set(connection, socket);
        this.bridgeWebSocketEvents(socket, connection, context);
        try {
            await this.waitForWebSocketOpen(socket, command, context.abortSignal?.());
        } catch (error) {
            this.closeWebSocketResource(connection, socket, undefined, undefined, {
                detachImmediately: true,
            });
            throw new Error(
                `${errorMessage(error)} url=${redactedWebSocketUrl(url)}`,
            );
        }

        const value = {
            connection,
            url: socket.url ?? url,
            protocol: socket.protocol,
            readyState: socket.readyState,
        };
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.ws.opened',
            commandId: command.commandId,
            connection,
            transport: 'ws',
            severity: 'info',
            payload: value,
        });

        return {
            status: 'ok',
            value,
            nextStatus: context.state().status,
        };
    }

    private bridgeWebSocketEvents(
        socket: RallarBlackBoxBrowserWebSocket,
        connection: string,
        context: RallarBlackBoxTestCommandContext,
    ): void {
        this.detachWebSocketListeners(connection);
        const disposers: Array<() => void> = [];
        disposers.push(addWebSocketListener(socket, 'message', event => {
            context.recordEvent({
                kind: 'message',
                topic: 'rallar.bb.ws.message',
                connection,
                transport: 'ws',
                severity: 'info',
                payload: {
                    data: toWebSocketMessageData(event),
                },
            });
        }));
        disposers.push(addWebSocketListener(socket, 'close', event => {
            this.webSockets.delete(connection);
            this.detachWebSocketListeners(connection);
            context.recordEvent({
                kind: 'event',
                topic: 'rallar.bb.ws.closed',
                connection,
                transport: 'ws',
                severity: 'warning',
                payload: toWebSocketClosePayload(event),
            });
        }));
        disposers.push(addWebSocketListener(socket, 'error', event => {
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.ws.error',
                connection,
                transport: 'ws',
                severity: 'error',
                payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                    topic: 'rallar.bb.ws.error',
                    severity: 'error',
                    connection,
                    transport: 'ws',
                    payload: {
                    event,
                },
                    source: 'browser-adapter',
                }),
            });
        }));
        this.webSocketDisposers.set(connection, disposers);
    }

    private detachWebSocketListeners(connection: string): void {
        const disposers = this.webSocketDisposers.get(connection);
        if (!disposers) {
            return;
        }

        this.webSocketDisposers.delete(connection);
        disposers.forEach(dispose => {
            try {
                dispose();
            } catch (_error) {
                // Listener cleanup is best-effort; command cleanup still closes the socket.
            }
        });
    }

    private waitForWebSocketOpen(
        socket: RallarBlackBoxBrowserWebSocket,
        command: Extract<CommandWithId, { kind: 'ws.open' }>,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        if (socket.readyState === WEBSOCKET_OPEN_STATE) {
            return Promise.resolve();
        }

        const timeoutMs = command.timeoutMs ?? this.defaultWsOpenTimeoutMs;
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup: Array<() => void> = [];
            const timeout = setTimeout(() => {
                complete(() => reject(new Error(
                    'WebSocket did not open within ' + timeoutMs + 'ms.',
                )));
            }, timeoutMs);

            const complete = (callback: () => void) => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeout);
                cleanup.forEach(dispose => dispose());
                signal?.removeEventListener('abort', abort);
                callback();
            };
            const abort = () => {
                complete(() => reject(toAbortError(signal?.reason)));
            };

            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener('abort', abort, {
                once: true,
            });

            cleanup.push(addWebSocketListener(socket, 'open', () => {
                complete(resolve);
            }));
            cleanup.push(addWebSocketListener(socket, 'error', () => {
                complete(() => reject(new Error('WebSocket failed before open.')));
            }));
            cleanup.push(addWebSocketListener(socket, 'close', event => {
                const closePayload = toWebSocketClosePayload(event);
                complete(() => reject(new Error(
                    'WebSocket closed before open. code=' +
                    String(closePayload.code) +
                    ', reason=' +
                    String(closePayload.reason),
                )));
            }));
        });
    }

    private async sendWebSocket(
        command: Extract<CommandWithId, { kind: 'ws.send' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const connection = command.connection ?? 'default';
        const socket = this.webSockets.get(connection);
        const shouldUseRallarSignaling = Boolean(this.rallarRuntime?.sendWs) &&
            configProviderMode(context.config()) === 'browser-rallar' &&
            isStructuredRallarWebSocketEnvelope(command.data);

        if (shouldUseRallarSignaling) {
            return await this.sendWebSocketViaRallar(command, context, connection);
        }

        if (!socket) {
            throw new Error('WebSocket connection is not open: ' + connection);
        }

        const resolvedData = replaceCommandPlaceholders(command.data, {
            config: context.config(),
            session: readOptionalBrowserSession(),
        });
        const data = toWebSocketSendData(resolvedData);
        const sendStartedAtEpochMs = Date.now();
        socket.send(data);
        const durationMs = Math.max(0, Date.now() - sendStartedAtEpochMs);
        const bufferedAmount = typeof socket.bufferedAmount === 'number'
            ? socket.bufferedAmount
            : undefined;
        const sendObservation = {
            commandId: command.commandId,
            kind: command.kind,
            transport: 'ws',
            durationMs,
            ok: true,
            status: bufferedAmount !== undefined && bufferedAmount > 0 ? 'queued' : 'sent',
            queued: bufferedAmount !== undefined && bufferedAmount > 0,
        };
        return {
            status: 'ok',
            value: {
                connection,
                sent: data,
                sendObservation,
            },
        };
    }

    private async sendWebSocketViaRallar(
        command: Extract<CommandWithId, { kind: 'ws.send' }>,
        context: RallarBlackBoxTestCommandContext,
        connection: string,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const runtime = this.requireRallarRuntime();
        const sendWs = runtime.sendWs;
        if (!sendWs) {
            throw new Error('Browser Rallar runtime does not support ws.send.');
        }
        const data = replaceCommandPlaceholders(command.data, {
            config: context.config(),
            session: readOptionalBrowserSession(),
        });
        let result: unknown;
        const abort = this.commandAbortSignal(command, context);
        const sendStartedAtEpochMs = Date.now();
        try {
            result = await this.withAbort(sendWs(data), abort.signal);
        } catch (error) {
            if (!isRuntimeNotConnectedError(error)) {
                throw error;
            }
            await this.withAbort(
                runtime.connect(
                    this.toRallarWebSocketConnectionConfig(command, context.config()),
                ),
                abort.signal,
            );
            result = await this.withAbort(sendWs(data), abort.signal);
        } finally {
            abort.cleanup();
        }
        const durationMs = Math.max(0, Date.now() - sendStartedAtEpochMs);
        const sendObservation = {
            commandId: command.commandId,
            kind: command.kind,
            transport: 'ws',
            durationMs,
            ok: true,
            status: 'sent',
        };

        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.ws.sent_via_rallar_signaling',
            commandId: command.commandId,
            connection,
            transport: 'ws',
            severity: 'info',
            payload: {
                connection,
                via: 'rallar-signaling-websocket',
                rallar: result,
                sendObservation,
            },
        });
        return {
            status: 'ok',
            value: {
                connection,
                via: 'rallar-signaling-websocket',
                sent: data,
                rallar: result,
                sendObservation,
            },
        };
    }

    private closeWebSocket(
        command: Extract<CommandWithId, { kind: 'ws.close' }>,
    ): RallarBlackBoxTestCommandOutcome {
        const connection = command.connection ?? 'default';
        const socket = this.webSockets.get(connection);
        if (!socket) {
            return {
                status: 'ok',
                value: {
                    connection,
                    closed: false,
                    reason: 'not-open',
                },
            };
        }

        this.closeWebSocketResource(connection, socket, command.code, command.reason);
        return {
            status: 'ok',
            value: {
                connection,
                closed: true,
            },
        };
    }

    private closeWebSocketResource(
        connection: string,
        socket: RallarBlackBoxBrowserWebSocket,
        code?: number,
        reason?: string,
        options: Readonly<{ detachImmediately?: boolean }> = {},
    ): void {
        try {
            socket.close(code, reason);
        } finally {
            this.webSockets.delete(connection);
            if (options.detachImmediately === true || socket.readyState === undefined) {
                this.detachWebSocketListeners(connection);
            }
        }
    }

    private async health(
        command: Extract<CommandWithId, { kind: 'health' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const rallar = this.rallarRuntime
            ? await this.rallarRuntime.health()
            : undefined;
        return {
            status: 'ok',
            value: {
                rallar,
                stats: context.updateStats(command.commandId),
                webSockets: [...this.webSockets.keys()],
            },
            nextStatus: context.state().status,
        };
    }

    private async close(
        command: Extract<CommandWithId, { kind: 'close' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const resources = await this.closeOwnedResources({
            rallar: true,
            tolerant: false,
        });
        const value = {
            closed: true,
            rallar: resources.rallar,
            webSocketCount: resources.webSocketCount,
        };
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.closed',
            commandId: command.commandId,
            severity: 'info',
            payload: value,
        });
        return {
            status: 'ok',
            value,
            nextStatus: 'idle',
        };
    }

    private async reset(): Promise<RallarBlackBoxTestCommandOutcome> {
        const value = await this.closeOwnedResources({
            rallar: true,
            tolerant: false,
        });
        return {
            status: 'ok',
            value: {
                reset: true,
                rallar: value.rallar,
                webSocketCount: value.webSocketCount,
            },
            nextStatus: 'idle',
        };
    }

    private async closeOwnedResources(options: Readonly<{
        rallar: boolean;
        tolerant: boolean;
    }>): Promise<{
        webSocketCount: number;
        rallar?: unknown;
        errors?: unknown[];
    }> {
        const errors: unknown[] = [];
        const webSockets = [...this.webSockets.entries()];
        webSockets.forEach(([connection, socket]) => {
            try {
                this.closeWebSocketResource(connection, socket, undefined, undefined, {
                    detachImmediately: true,
                });
            } catch (error) {
                errors.push({
                    connection,
                    error,
                });
            } finally {
                this.detachWebSocketListeners(connection);
            }
        });
        this.webSockets.clear();
        this.webSocketDisposers.forEach((_disposers, connection) => {
            this.detachWebSocketListeners(connection);
        });

        let rallar: unknown;
        if (options.rallar && this.rallarRuntime) {
            try {
                rallar = await this.rallarRuntime.close();
            } catch (error) {
                errors.push({
                    connection: 'rallar',
                    error,
                });
            }
        }

        if (errors.length > 0 && !options.tolerant) {
            throw new Error('Failed to close one or more browser adapter resources.');
        }

        return {
            webSocketCount: webSockets.length,
            rallar,
            ...(errors.length > 0 ? { errors } : {}),
        };
    }
}

export function createRallarBlackBoxBrowserTestRuntime(
    options: CreateRallarBlackBoxBrowserTestRuntimeOptions = {},
): RallarBlackBoxBrowserTestRuntime {
    const adapter = new BrowserCommandAdapter(options);
    const runtime = createRallarBlackBoxTestRuntime({
        now: options.now,
        sleep: options.sleep,
        idFactory: options.idFactory,
        commandExecutor: (command, context) => adapter.execute(command, context),
        cleanup: (input, context) => adapter.cleanupOwnedResources(input, context),
    });

    return Object.assign(runtime, {
        receiveRallarBrowserEvent(event: RallarBlackBoxBrowserRallarEvent): void {
            runtime.recordEvent(toRallarBrowserEventInput(event));
        },
    });
}
