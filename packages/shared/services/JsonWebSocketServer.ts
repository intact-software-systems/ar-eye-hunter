export interface WebSocketServerCallbacks {
    onConnection?: (ctx: ConnectionContext) => void;
    onError?: (ctx: ConnectionContext, ev: Event) => void;
    onClose?: (ctx: ConnectionContext, ev: CloseEvent) => void;

    /**
     * Called when a client sends non-JSON text (JSON.parse fails).
     * You can omit this if you want to ignore parse errors.
     */
    onParseError?: (ctx: ConnectionContext, rawText: string, error: unknown) => void;
}

export interface WebSocketServerOnMessageCallback {
    onMessage: (ctx: ConnectionContext, data: unknown, ev: MessageEvent) => Promise<void>;
}

export class ConnectionContext {
    constructor(
        public readonly id: string,
        public readonly socket: WebSocket
    ) {
    }

    get isOpen(): boolean {
        return this.socket.readyState === WebSocket.OPEN;
    }
}

export class JsonWebSocketServer {
    private readonly webSocketServerCallbacks = new Map<string, WebSocketServerCallbacks>();
    private readonly onMessageCallbacks = new Map<string, WebSocketServerOnMessageCallback>();

    public readonly connections = new Map<string, ConnectionContext>();

    // --------------------
    // Callback registry
    // --------------------

    onMessageDo(id: string, onMessage: WebSocketServerOnMessageCallback): this {
        this.onMessageCallbacks.set(id, onMessage);
        return this;
    }

    onWebsocketCallbacksDo(id: string, callbacks: WebSocketServerCallbacks): this {
        this.webSocketServerCallbacks.set(id, callbacks);
        return this;
    }

    removeWebsocketCallbackById(id: string): boolean {
        return this.webSocketServerCallbacks.delete(id);
    }

    removeOnMessageCallbackById(id: string): boolean {
        return this.onMessageCallbacks.delete(id);
    }

    // --------------------
    // Add connection
    // --------------------

    addConnection(ctx: ConnectionContext): void {
        this.connections.set(ctx.id, ctx);

        this.addAllEventListeners(ctx);
    }

    private addAllEventListeners(ctx: ConnectionContext) {
        ctx.socket.addEventListener("open", (_: Event) => {
            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    cb.onConnection?.(ctx);
                } catch (e) {
                    console.error("Callback onConnection failed:", e);
                }
            }
        });

        ctx.socket.addEventListener("message", async (ev: MessageEvent) => {
            // Typical is string payload for JSON.
            const raw = ev.data;

            // Pass unknown as-is if not a string (binary frames etc.)
            let decoded: unknown = raw;
            if (typeof raw === "string") {
                try {
                    decoded = JSON.parse(raw);
                } catch (e) {
                    // Give the caller a chance to handle parse errors
                    for (const cb of this.webSocketServerCallbacks.values()) {
                        try {
                            cb.onParseError?.(ctx, raw, e);
                        } catch (e2) {
                            console.error("Callback onParseError failed:", e2);
                        }
                    }
                    // Keep decoded as raw string (so message handlers still see something)
                    decoded = raw;
                }
            }

            for (const cb of this.onMessageCallbacks.values()) {
                try {
                    await cb.onMessage(ctx, decoded, ev);
                } catch (e) {
                    console.error("Callback onMessage failed:", e);
                }
            }
        });

        ctx.socket.addEventListener("error", (ev: Event) => {
            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    cb.onError?.(ctx, ev);
                } catch (e) {
                    console.error("Callback onError failed:", e);
                }
            }
        });

        ctx.socket.addEventListener("close", (ev: CloseEvent) => {
            this.connections.delete(ctx.id);

            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    cb.onClose?.(ctx, ev);
                } catch (e) {
                    console.error("Callback onClose failed:", e);
                }
            }
        });
    }

    // --------------------
    // Send API
    // --------------------

    send(connectionId: string, data: unknown): void {
        const ctx = this.connections.get(connectionId);
        if (!ctx || !ctx.isOpen) {
            throw new Error(`JsonWebSocketServer: cannot send; connection not open: ${connectionId}`);
        }

        const encoded = JSON.stringify(data);
        ctx.socket.send(encoded);
    }

    broadcast(data: unknown, filter?: (ctx: ConnectionContext) => boolean): number {
        const encoded = JSON.stringify(data);

        let count = 0;
        for (const ctx of this.connections.values()) {
            if (!ctx.isOpen) continue;
            if (filter && !filter(ctx)) continue;

            try {
                ctx.socket.send(encoded);
                count += 1;
            } catch (e) {
                console.error("Broadcast send failed:", e);
            }
        }
        return count;
    }
}