import type { CreateRallarBlackBoxTestRuntimeOptions, } from './runtime.ts';
import { createRallarBlackBoxTestRuntime } from './runtime.ts';
import {
    inferRallarBlackBoxDiagnosticSeverity,
    normalizeRallarBlackBoxRuntimeDiagnostic,
} from './diagnostics.ts';
import { readSession } from '@shared/api/auth.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig,
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

export type RallarBlackBoxBrowserRallarRuntime = Readonly<{
    connect(config: RallarBlackBoxBrowserRallarConnectionConfig): Promise<unknown>;
    send(input: unknown): Promise<unknown>;
    sendWs?(input: unknown): Promise<unknown>;
    close(): Promise<unknown>;
    health(): Promise<unknown>;
}>;

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

const DEFAULT_WS_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_HTTP_BODY_LIMIT = 64_000;

const WEBSOCKET_OPEN_STATE = 1;
const AUTH_PLACEHOLDER_PATTERN = /\{auth\.(clientId|username|sessionId|accessToken|wsTicket)\}/g;
const CONFIG_PLACEHOLDER_PATTERN = /\{config\.(apiBaseUrl|wsBaseUrl)\}/g;
const AUTH_PLACEHOLDER_TEST_PATTERN = /\{auth\.(clientId|username|sessionId|accessToken|wsTicket)\}/;
const CONFIG_PLACEHOLDER_TEST_PATTERN = /\{config\.(apiBaseUrl|wsBaseUrl)\}/;

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

function commandLocalDelayMs(command: CommandWithId): number {
    const value = command.metadata?.localDelayMs;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, value);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

function isRallarWebSocketEnvelope(value: unknown): boolean {
    const record = asRecord(value);
    return [
        'applicationId',
        'workspaceId',
        'scope',
        'roomId',
        'groupId',
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

function requiresWsTicketPlaceholder(value: unknown): boolean {
    if (typeof value === 'string') {
        return value.includes('{auth.wsTicket}');
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
        wsTicket?: string;
    }>,
): string {
    return value
        .replace(CONFIG_PLACEHOLDER_PATTERN, (_match, key: string) => {
            const replacement = key === 'apiBaseUrl'
                ? configApiBaseUrl(options.config)
                : configWsBaseUrl(options.config);
            if (!replacement) {
                throw new Error(`Cannot resolve recipe placeholder {config.${key}} without configured ${key}.`);
            }

            return replacement;
        })
        .replace(AUTH_PLACEHOLDER_PATTERN, (_match, key: string) => {
            if (key === 'wsTicket') {
                if (!options.wsTicket) {
                    throw new Error('Cannot resolve recipe placeholder {auth.wsTicket} without a websocket ticket.');
                }

                return options.wsTicket;
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
                    return options.session.sessionId;
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
        wsTicket?: string;
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
): Promise<string> {
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

    return body.ticket;
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
            await sleep(delayMs);
        }

        switch (command.kind) {
            case 'rtc.connect':
                return await this.connectRtc(command, context);
            case 'rtc.send':
                return await this.sendRtc(command, context);
            case 'ws.open':
                return await this.openWebSocket(command, context);
            case 'ws.send':
                return await this.sendWebSocket(command, context);
            case 'ws.close':
                return this.closeWebSocket(command);
            case 'http.request':
                return await this.httpRequest(command, context);
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
        const diagnostics = await this.requireRallarRuntime().connect(connectionConfig);
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
                data: diagnostics,
                payload: diagnostics,
                source: 'browser-adapter',
            }),
        });

        return {
            status: 'ok',
            value: diagnostics,
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
        const diagnostics = await this.requireRallarRuntime().send(scopedSend);
        const failure = rtcSendFailureFromDiagnostics(diagnostics);
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
                }
                    : diagnostics,
                message: failure?.message,
                error: failure,
                source: 'browser-adapter',
            }),
        });

        if (failure) {
            return {
                status: 'failed',
                value: diagnostics,
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
            value: diagnostics,
            nextStatus: context.state().status,
        };
    }

    private async httpRequest(
        command: Extract<CommandWithId, { kind: 'http.request' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const session = readOptionalBrowserSession();
        const config = context.config();
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
        const response = await this.requireFetch()(url, {
            method: resolvedRequest.method,
            headers,
            body: resolvedRequest.body === undefined
                ? undefined
                : typeof resolvedRequest.body === 'string'
                    ? resolvedRequest.body
                    : JSON.stringify(resolvedRequest.body),
            credentials: resolvedRequest.credentials,
            mode: resolvedRequest.mode,
        });
        const responseOptions = asRecord(command.response) as HttpResponseOptions;
        const body = await readHttpBody(
            response,
            responseOptions,
            this.defaultHttpBodyLimit,
        );
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
        const session = readOptionalBrowserSession();
        const config = context.config();
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
        await this.waitForWebSocketOpen(socket, command);

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
        addWebSocketListener(socket, 'message', event => {
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
        });
        addWebSocketListener(socket, 'close', event => {
            this.webSockets.delete(connection);
            context.recordEvent({
                kind: 'event',
                topic: 'rallar.bb.ws.closed',
                connection,
                transport: 'ws',
                severity: 'warning',
                payload: toWebSocketClosePayload(event),
            });
        });
        addWebSocketListener(socket, 'error', event => {
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
        });
    }

    private waitForWebSocketOpen(
        socket: RallarBlackBoxBrowserWebSocket,
        command: Extract<CommandWithId, { kind: 'ws.open' }>,
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
                callback();
            };

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
            isRallarWebSocketEnvelope(command.data);

        if (shouldUseRallarSignaling || !socket) {
            if (this.rallarRuntime?.sendWs) {
                return await this.sendWebSocketViaRallar(command, context, connection);
            }
            throw new Error('WebSocket connection is not open: ' + connection);
        }

        const data = toWebSocketSendData(command.data);
        socket.send(data);
        return {
            status: 'ok',
            value: {
                connection,
                sent: data,
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
        try {
            result = await sendWs(data);
        } catch (error) {
            if (!isRuntimeNotConnectedError(error)) {
                throw error;
            }
            await runtime.connect(
                this.toRallarWebSocketConnectionConfig(command, context.config()),
            );
            result = await sendWs(data);
        }

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
            },
        });
        return {
            status: 'ok',
            value: {
                connection,
                via: 'rallar-signaling-websocket',
                sent: data,
                rallar: result,
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

        socket.close(command.code, command.reason);
        this.webSockets.delete(connection);
        return {
            status: 'ok',
            value: {
                connection,
                closed: true,
            },
        };
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
        const webSockets = [...this.webSockets.entries()];
        webSockets.forEach(([_connection, socket]) => {
            socket.close();
        });
        this.webSockets.clear();
        const rallar = this.rallarRuntime
            ? await this.rallarRuntime.close()
            : undefined;
        const value = {
            closed: true,
            rallar,
            webSocketCount: webSockets.length,
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
        const webSockets = [...this.webSockets.values()];
        webSockets.forEach(socket => {
            socket.close();
        });
        this.webSockets.clear();
        const rallar = this.rallarRuntime
            ? await this.rallarRuntime.close()
            : undefined;
        return {
            status: 'ok',
            value: {
                reset: true,
                rallar,
                webSocketCount: webSockets.length,
            },
            nextStatus: 'idle',
        };
    }
}

export function createRallarBlackBoxBrowserTestRuntime(
    options: CreateRallarBlackBoxBrowserTestRuntimeOptions = {},
): RallarBlackBoxBrowserTestRuntime {
    const adapter = new BrowserCommandAdapter(options);
    const runtime = createRallarBlackBoxTestRuntime({
        now: options.now,
        idFactory: options.idFactory,
        commandExecutor: (command, context) => adapter.execute(command, context),
    });

    return Object.assign(runtime, {
        receiveRallarBrowserEvent(event: RallarBlackBoxBrowserRallarEvent): void {
            runtime.recordEvent(toRallarBrowserEventInput(event));
        },
    });
}
