import { validateJsonMessageSize, type JsonMessageRejection } from '../api/json-message-validation.ts';

export interface WebSocketClientCallbacks {
    onOpen?: (ev: Event) => void;
    onError?: (ev: Event) => void;
    onClose?: (ev: CloseEvent) => void;
}

export interface OnWebSocketMessageCallback {
    readonly maxMessageBytes?: number;
    onRejected?: (reason: JsonMessageRejection, ev: MessageEvent) => Promise<void>;
    onMessage: (data: unknown, ev: MessageEvent) => Promise<void>;
}

export interface WebSocketConnectOptions {
    readonly requestId?: string;
    readonly signal?: AbortSignal;
}

export type WebSocketUrlProvider = (
    options: WebSocketConnectOptions
) => string | Promise<string>;

export class JsonWebSocketClient {
    public url: string;
    public ws?: WebSocket = undefined;
    private connectPromise?: Promise<void> = undefined;
    private readonly urlProvider: WebSocketUrlProvider;

    private readonly webSocketClientCallbacks = new Map<string, WebSocketClientCallbacks>();
    private readonly onMessageCallbacks = new Map<string, OnWebSocketMessageCallback>();

    constructor(url: string | WebSocketUrlProvider) {
        if (typeof url === 'string') {
            this.url = url;
            this.urlProvider = () => url;
            return;
        }

        this.url = '';
        this.urlProvider = url;
    }

    // --------------------
    // Callback registry
    // --------------------

    onWebSocketMessageDo(
        id: string,
        onMessage: OnWebSocketMessageCallback
    ) {
        this.onMessageCallbacks.set(id, onMessage);
        return this;
    }

    onWebsocketCallbacksDo(
        id: string,
        webSocketClientCallbacks: WebSocketClientCallbacks
    ) {
        this.webSocketClientCallbacks.set(id, webSocketClientCallbacks);
        return this;
    }

    removeWebsocketCallbackById(id: string): boolean {
        return this.webSocketClientCallbacks.delete(id);
    }

    removeOnMessageCallbackById(id: string): boolean {
        return this.onMessageCallbacks.delete(id);
    }

    // --------------------
    // Connect, send and close
    // --------------------

    async connect(options: WebSocketConnectOptions = {}): Promise<void> {
        if (this.ws?.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

        if (options.signal?.aborted) {
            throw new Error('WebSocket connect aborted.');
        }

        if (!this.connectPromise) {
            let connectPromise: Promise<void>;
            connectPromise = this.openSocket(options)
                .finally(() => {
                    if (this.connectPromise === connectPromise) {
                        this.connectPromise = undefined;
                    }
                });
            this.connectPromise = connectPromise;
        }

        return await this.connectPromise;
    }

    private async openSocket(options: WebSocketConnectOptions): Promise<void> {
        const nextUrl = await this.urlProvider(options);
        if (options.signal?.aborted) {
            throw new Error('WebSocket connect aborted.');
        }
        this.url = nextUrl;
        const socket = new WebSocket(nextUrl);
        this.ws = socket;
        const opened = this.waitForSocketOpen(socket, options.signal);
        this.addSocketEventListeners(socket);
        await opened;
    }

    private waitForSocketOpen(socket: WebSocket, signal: AbortSignal | undefined): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = (error: Error | undefined) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                socket.removeEventListener('open', onOpen);
                socket.removeEventListener('error', onError);
                socket.removeEventListener('close', onClose);
                if (error) {
                    reject(error);
                }
                else {
                    resolve();
                }
            };
            const onOpen = () => settle(undefined);
            const onError = (event: Event) => settle(new Error('WebSocket error. Type: ' + event.type));
            const onClose = (event: CloseEvent) =>
                settle(new Error('WebSocket is closed. Code: ' + event.code + ' Reason ' + event.reason));
            const onAbort = () => {
                if (this.ws === socket) {
                    this.ws = undefined;
                }
                settle(new Error('WebSocket connect aborted.'));
                socket.close(1000, 'connect-aborted');
            };
            socket.addEventListener('open', onOpen);
            socket.addEventListener('error', onError);
            socket.addEventListener('close', onClose);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
            }
        });
    }

    private addSocketEventListeners(socket: WebSocket): void {
        socket.addEventListener('open', (event: Event) => this.notifyOpen(event));
        socket.addEventListener('message', (event: MessageEvent) => this.dispatchMessage(socket, event));
        socket.addEventListener('error', (event: Event) => this.notifyError(event));
        socket.addEventListener('close', (event: CloseEvent) => {
            this.notifyClose(event);
            if (this.ws === socket) {
                this.ws = undefined;
            }
        });
    }

    private notifyOpen(event: Event): void {
        for (const callback of this.webSocketClientCallbacks.values()) {
            try {
                callback.onOpen?.(event);
            }
            catch (error) {
                console.error('Callback onOpen failed:', error);
            }
        }
    }

    private notifyError(event: Event): void {
        for (const callback of this.webSocketClientCallbacks.values()) {
            try {
                callback.onError?.(event);
            }
            catch (error) {
                console.error('Callback onError failed:', error);
            }
        }
    }

    private notifyClose(event: CloseEvent): void {
        for (const callback of this.webSocketClientCallbacks.values()) {
            try {
                callback.onClose?.(event);
            }
            catch (error) {
                console.error('Callback onClose failed:', error);
            }
        }
    }

    private async dispatchMessage(socket: WebSocket, event: MessageEvent): Promise<void> {
        for (const callback of this.onMessageCallbacks.values()) {
            if (this.ws !== socket) {
                return;
            }
            try {
                if (callback.maxMessageBytes !== undefined) {
                    const validated = validateJsonMessageSize(event.data, callback.maxMessageBytes);
                    if (validated.left) {
                        await callback.onRejected?.(validated.left, event);
                        continue;
                    }
                }
                await callback.onMessage(JSON.parse(event.data), event);
            }
            catch (error) {
                console.error('Callback onMessage failed:', error);
            }
        }
    }

    send(data: unknown): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocketClient: cannot send; socket is not open.');
        }

        this.ws.send(JSON.stringify(data));
    }

    sendAsJsonString(data: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocketClient: cannot send; socket is not open.');
        }

        this.ws.send(data);
    }

    close(code?: number, reason?: string): void {
        this.ws?.close(code, reason);
        this.ws = undefined;
        this.connectPromise = undefined;
    }
}
