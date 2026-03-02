export interface WebSocketClientCallbacks {
    onOpen?: (ev: Event) => void;
    onError?: (ev: Event) => void;
    onClose?: (ev: CloseEvent) => void;
}

export interface OnWebSocketMessageCallback {
    onMessage: (data: unknown, ev: MessageEvent) => Promise<void>
}

export class JsonWebSocketClient {
    public readonly url: string;
    public ws?: WebSocket = undefined;
    private connectPromise?: Promise<void> = undefined;

    private readonly webSocketClientCallbacks = new Map<string, WebSocketClientCallbacks>();
    private readonly onMessageCallbacks = new Map<string, OnWebSocketMessageCallback>();

    constructor(url: string) {
        this.url = url;
    }

    // --------------------
    // Callback registry
    // --------------------

    onWebSocketMessageDo(
        id: string,
        onMessage: OnWebSocketMessageCallback
    ) {
        this.onMessageCallbacks.set(id, onMessage);
        return this
    }

    onWebsocketCallbacksDo(
        id: string,
        webSocketClientCallbacks: WebSocketClientCallbacks
    ) {
        this.webSocketClientCallbacks.set(id, webSocketClientCallbacks);
        return this
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

    async connect(): Promise<void> {
        if (this?.ws?.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

        if (!this.connectPromise) {
            this.connectPromise = new Promise<void>(
                (resolve, reject) => {
                    this.ws = new WebSocket(this.url);

                    let isOpened = false
                    let isRejected = false;

                    this.ws.addEventListener(
                        "open",
                        (ev: Event) => {
                            isOpened = true

                            for (const callback of this.webSocketClientCallbacks.values()) {
                                try {
                                    callback?.onOpen?.(ev)
                                } catch (e) {
                                    console.error("Callback onOpen failed:", e);
                                }
                            }
                            resolve()

                            this.connectPromise = undefined
                        }
                    )

                    this.ws.addEventListener(
                        "message",
                        async (ev: MessageEvent) => {
                            for (const callback of this.onMessageCallbacks.values()) {
                                try {
                                    await callback.onMessage(JSON.parse(ev.data), ev)
                                } catch (e) {
                                    console.error("Callback onMessage failed:", e);
                                }
                            }
                        }
                    )

                    this.ws.addEventListener(
                        "error",
                        (ev: Event) => {
                            for (const callback of this.webSocketClientCallbacks.values()) {
                                try {
                                    callback?.onError?.(ev)
                                } catch (e) {
                                    console.error("Callback onError failed:", e);
                                }
                            }

                            this.connectPromise = undefined

                            if (!isOpened && !isRejected) {
                                isRejected = true
                                reject(new Error("WebSocket error. Type: " + ev.type));
                            }
                        }
                    )

                    this.ws.addEventListener(
                        "close",
                        (ev: CloseEvent) => {

                            for (const callback of this.webSocketClientCallbacks.values()) {
                                try {
                                    callback?.onClose?.(ev)
                                } catch (e) {
                                    console.error("Callback onClose failed:", e);
                                }
                            }

                            this.connectPromise = undefined
                            this.ws = undefined

                            if (!isOpened && !isRejected) {
                                isRejected = true
                                reject(new Error("WebSocket is closed. Code: " + ev.code + " Reason " + ev.reason));
                            }
                        }
                    )
                }
            );
        }

        return await this.connectPromise
    }

    send(data: unknown): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocketClient: cannot send; socket is not open.");
        }

        this.ws.send(JSON.stringify(data));
    }

    sendAsJsonString(data: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocketClient: cannot send; socket is not open.");
        }

        this.ws.send(data);
    }

    close(code?: number, reason?: string): void {
        this?.ws?.close(code, reason);
        this.ws = undefined;
        this.connectPromise = undefined;
    }
}