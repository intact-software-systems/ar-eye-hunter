import type { CreateRallarBlackBoxTestRuntimeOptions, } from './runtime.ts';
import { createRallarBlackBoxTestRuntime } from './runtime.ts';
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
    rallar: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxBrowserRallarRuntime = Readonly<{
    connect(config: RallarBlackBoxBrowserRallarConnectionConfig): Promise<unknown>;
    send(input: unknown): Promise<unknown>;
    close(): Promise<unknown>;
    health(): Promise<unknown>;
}>;

export type RallarBlackBoxBrowserRallarEvent = Readonly<{
    kind?: 'diagnostic' | 'message' | 'close';
    topic?: string;
    connection?: string;
    actor?: string;
    transport?: RallarBlackBoxBrowserRallarTransport;
    roomId?: string;
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

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function firstDefined<T>(...values: readonly T[]): T | undefined {
    return values.find(value => value !== undefined);
}

function toStringValue(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
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

function toHeadersRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
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
): string {
    if (request.request.url) {
        return request.request.url;
    }

    if (!request.request.path) {
        throw new Error('http.request requires request.url or request.path.');
    }

    const apiBaseUrl = config?.apiBaseUrl ??
        toStringValue(asRecord(config?.rallar).apiBaseUrl);
    if (!apiBaseUrl) {
        throw new Error('http.request path requires configured apiBaseUrl.');
    }

    return new URL(request.request.path, apiBaseUrl).toString();
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

    return {
        kind,
        topic: event.topic ?? 'rallar.browser.event',
        connection: event.connection,
        actor: event.actor,
        transport: toEventTransport(event.transport),
        severity: event.error ? 'error' : event.kind === 'close' ? 'warning' : 'info',
        payload,
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
        switch (command.kind) {
            case 'rtc.connect':
                return await this.connectRtc(command, context);
            case 'rtc.send':
                return await this.sendRtc(command, context);
            case 'ws.open':
                return await this.openWebSocket(command, context);
            case 'ws.send':
                return this.sendWebSocket(command);
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
        const rallar = {
            ...configuredRallar,
            ...commandRallar,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            ...(transport ? { transport } : {}),
        };

        return {
            connection: command.connection ??
                toStringValue(asRecord(config?.defaults).connection) ??
                config?.actor ??
                'default',
            actor: command.actor ?? config?.actor,
            roomId: command.roomId ?? config?.roomId,
            rallar,
        };
    }

    private async connectRtc(
        command: Extract<CommandWithId, { kind: 'rtc.connect' }>,
        context: RallarBlackBoxTestCommandContext,
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const connectionConfig = this.toRallarConnectionConfig(command, context.config());
        const diagnostics = await this.requireRallarRuntime().connect(connectionConfig);
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.rtc.connected',
            commandId: command.commandId,
            connection: connectionConfig.connection,
            actor: connectionConfig.actor,
            transport: toRtcTransport(connectionConfig.rallar.transport),
            severity: 'info',
            payload: diagnostics,
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
        const diagnostics = await this.requireRallarRuntime().send(command.send ?? {});
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.rtc.send_completed',
            commandId: command.commandId,
            connection: command.connection,
            transport: command.transport,
            severity: 'info',
            payload: diagnostics,
        });

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
        const url = toRequestUrl(command, context.config());
        const request = command.request;
        const response = await this.requireFetch()(url, {
            method: request.method,
            headers: request.headers,
            body: request.body === undefined
                ? undefined
                : typeof request.body === 'string'
                    ? request.body
                    : JSON.stringify(request.body),
            credentials: request.credentials,
            mode: request.mode,
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
        const url = command.url;
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
                payload: {
                    reason: 'Browser WebSocket constructors cannot set custom headers.',
                    headers: command.headers,
                },
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
                payload: {
                    event,
                },
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

    private sendWebSocket(
        command: Extract<CommandWithId, { kind: 'ws.send' }>,
    ): RallarBlackBoxTestCommandOutcome {
        const connection = command.connection ?? 'default';
        const socket = this.webSockets.get(connection);
        if (!socket) {
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
