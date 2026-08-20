export interface WebSocketClientCallbacks {
    onOpen?: (ev: Event) => void;
    onError?: (ev: Event) => void;
    onClose?: (ev: CloseEvent) => void;
}

export interface OnWebSocketMessageCallback {
    onMessage: (data: unknown, ev: MessageEvent) => Promise<void>;
}

export type WebSocketConnectOptions = Readonly<{
    requestId?: string;
    signal?: AbortSignal;
}>;

export type WebSocketUrlProvider = (
    options: WebSocketConnectOptions,
) => string | Promise<string>;

export class JsonWebSocketClient {
    public url: string;
    public ws?: WebSocket = undefined;
    private connectPromise?: Promise<void> = undefined;
    private readonly urlProvider: WebSocketUrlProvider;

    private readonly webSocketClientCallbacks = new Map<
        string,
        WebSocketClientCallbacks
    >();
    private readonly onMessageCallbacks = new Map<
        string,
        OnWebSocketMessageCallback
    >();

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
        onMessage: OnWebSocketMessageCallback,
    ) {
        this.onMessageCallbacks.set(id, onMessage);
        return this;
    }

    onWebsocketCallbacksDo(
        id: string,
        webSocketClientCallbacks: WebSocketClientCallbacks,
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
        if (this?.ws?.readyState === WebSocket.OPEN) {
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

        await new Promise<void>(
            (resolve, reject) => {
                const socket = new WebSocket(nextUrl);
                this.ws = socket;

                let isOpened = false;
                let isRejected = false;

                const cleanupAbortListener = () => {
                    options.signal?.removeEventListener('abort', abortConnect);
                };

                const abortConnect = () => {
                    if (isOpened || isRejected) {
                        return;
                    }

                    isRejected = true;
                    cleanupAbortListener();
                    if (this.ws === socket) {
                        this.ws = undefined;
                    }
                    socket.close(1000, 'connect-aborted');
                    reject(new Error('WebSocket connect aborted.'));
                };

                options.signal?.addEventListener('abort', abortConnect, {
                    once: true,
                });
                if (options.signal?.aborted) {
                    abortConnect();
                }

                socket.addEventListener(
                    'open',
                    (ev: Event) => {
                        isOpened = true;
                        cleanupAbortListener();

                        for (const callback of this.webSocketClientCallbacks.values()) {
                            try {
                                callback?.onOpen?.(ev);
                            } catch (e) {
                                console.error('Callback onOpen failed:', e);
                            }
                        }
                        resolve();
                    },
                );

                socket.addEventListener(
                    'message',
                    async (ev: MessageEvent) => {
                        if (this.ws !== socket) {
                            return;
                        }

                        for (const callback of this.onMessageCallbacks.values()) {
                            try {
                                await callback.onMessage(JSON.parse(ev.data), ev);
                            } catch (e) {
                                console.error('Callback onMessage failed:', e);
                            }
                        }
                    },
                );

                socket.addEventListener(
                    'error',
                    (ev: Event) => {
                        cleanupAbortListener();

                        for (const callback of this.webSocketClientCallbacks.values()) {
                            try {
                                callback?.onError?.(ev);
                            } catch (e) {
                                console.error('Callback onError failed:', e);
                            }
                        }

                        if (!isOpened && !isRejected) {
                            isRejected = true;
                            reject(new Error('WebSocket error. Type: ' + ev.type));
                        }
                    },
                );

                socket.addEventListener(
                    'close',
                    (ev: CloseEvent) => {
                        cleanupAbortListener();

                        for (const callback of this.webSocketClientCallbacks.values()) {
                            try {
                                callback?.onClose?.(ev);
                            } catch (e) {
                                console.error('Callback onClose failed:', e);
                            }
                        }

                        if (this.ws === socket) {
                            this.ws = undefined;
                        }

                        if (!isOpened && !isRejected) {
                            isRejected = true;
                            reject(
                                new Error(
                                    'WebSocket is closed. Code: ' + ev.code + ' Reason ' +
                                    ev.reason,
                                ),
                            );
                        }
                    },
                );
            },
        );
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
        this?.ws?.close(code, reason);
        this.ws = undefined;
        this.connectPromise = undefined;
    }
}
