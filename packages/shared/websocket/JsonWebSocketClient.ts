export interface WebSocketClientCallbacks {
    onOpen?: (ev: Event) => void;
    onError?: (ev: Event) => void;
    onClose?: (ev: CloseEvent) => void;
}

export interface OnWebSocketMessageCallback {
    onMessage: (data: unknown, ev: MessageEvent) => Promise<void>;
}

export type WebSocketConnectOptions = Readonly<{
    signal?: AbortSignal;
}>;

export class JsonWebSocketClient {
    public readonly url: string;
    public ws?: WebSocket = undefined;
    private connectPromise?: Promise<void> = undefined;

    private readonly webSocketClientCallbacks = new Map<
        string,
        WebSocketClientCallbacks
    >();
    private readonly onMessageCallbacks = new Map<
        string,
        OnWebSocketMessageCallback
    >();

    constructor(url: string) {
        this.url = url;
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
            this.connectPromise = new Promise<void>(
                (resolve, reject) => {
                    this.ws = new WebSocket(this.url);

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
                        this.connectPromise = undefined;
                        this.ws?.close(1000, 'connect-aborted');
                        reject(new Error('WebSocket connect aborted.'));
                    };

                    options.signal?.addEventListener('abort', abortConnect, {
                        once: true,
                    });
                    if (options.signal?.aborted) {
                        abortConnect();
                    }

                    this.ws.addEventListener(
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

                            this.connectPromise = undefined;
                        },
                    );

                    this.ws.addEventListener(
                        'message',
                        async (ev: MessageEvent) => {
                            for (const callback of this.onMessageCallbacks.values()) {
                                try {
                                    await callback.onMessage(JSON.parse(ev.data), ev);
                                } catch (e) {
                                    console.error('Callback onMessage failed:', e);
                                }
                            }
                        },
                    );

                    this.ws.addEventListener(
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

                            this.connectPromise = undefined;

                            if (!isOpened && !isRejected) {
                                isRejected = true;
                                reject(new Error('WebSocket error. Type: ' + ev.type));
                            }
                        },
                    );

                    this.ws.addEventListener(
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

                            this.connectPromise = undefined;
                            this.ws = undefined;

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

        return await this.connectPromise;
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
