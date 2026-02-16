// JsonWebSocketServer.ts
// Deno runtime.
// - No hardcoded paths/URLs
// - Can be instantiated many times
// - Works with routers via handleRequest(req)
// - Optional start()/stop() convenience
// - JSON send + JSON parse on receive (text frames)
// - Multi-listener registries using Map<string, ...> like your JsonWebSocketClient

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

export interface OnMessageCallback {
    onMessage: (ctx: ConnectionContext, data: unknown, ev: MessageEvent) => void;
}

export interface JsonWebSocketServerOptions {
    /**
     * Optional filter to decide whether to accept websocket upgrades.
     * Return true to accept, false to reject.
     */
    accept?: (req: Request) => boolean;

    /**
     * Optional: create stable client IDs for connections.
     * Default: crypto.randomUUID()
     */
    createClientId?: (req: Request) => string;

    /**
     * Optional JSON decoder for inbound text frames.
     * Default: JSON.parse
     */
    decode?: (text: string) => unknown;

    /**
     * Optional JSON encoder for outbound messages.
     * Default: JSON.stringify
     */
    encode?: (data: unknown) => string;
}

export class ConnectionContext {
    constructor(
        public readonly id: string,
        public readonly socket: WebSocket,
        public readonly request: Request,
    ) {}

    get isOpen(): boolean {
        return this.socket.readyState === WebSocket.OPEN;
    }
}

export class JsonWebSocketServer {
    private readonly options: JsonWebSocketServerOptions;

    private readonly webSocketServerCallbacks = new Map<string, WebSocketServerCallbacks>();
    private readonly onMessageCallbacks = new Map<string, OnMessageCallback>();

    private readonly connections = new Map<string, ConnectionContext>();

    // Only used if you call start()
    private abort?: AbortController;

    constructor(options: JsonWebSocketServerOptions = {}) {
        this.options = options;
    }

    // --------------------
    // Callback registry
    // --------------------
    onMessageDo(id: string, onMessage: OnMessageCallback): this {
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
    // Connection registry
    // --------------------
    listConnectionIds(): string[] {
        return [...this.connections.keys()];
    }

    getConnection(id: string): ConnectionContext | undefined {
        return this.connections.get(id);
    }

    // --------------------
    // Router integration (recommended)
    // --------------------
    /**
     * Plug this into your router. Example:
     *   if (req.headers.get("upgrade") === "websocket") return server.handleRequest(req);
     */
    handleRequest(req: Request): Response {
        if (this.options.accept && !this.options.accept(req)) {
            return new Response("WebSocket rejected", { status: 403 });
        }

        // Deno upgrade:
        const { socket, response } = Deno.upgradeWebSocket(req);
        const id = this.createClientId(req);
        const ctx = new ConnectionContext(id, socket, req);

        this.connections.set(id, ctx);

        // Wire events
        socket.addEventListener("open", ev => {
            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    cb.onConnection?.(ctx);
                } catch (e) {
                    console.error("Callback onConnection failed:", e);
                }
            }
        });

        socket.addEventListener("message", (ev: MessageEvent) => {
            // Typical is string payload for JSON.
            const raw = ev.data;

            // Pass unknown as-is if not a string (binary frames etc.)
            let decoded: unknown = raw;
            if (typeof raw === "string") {
                try {
                    decoded = (this.options.decode ?? JSON.parse)(raw);
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
                    cb.onMessage(ctx, decoded, ev);
                } catch (e) {
                    console.error("Callback onMessage failed:", e);
                }
            }
        });

        socket.addEventListener("error", (ev: Event) => {
            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    cb.onError?.(ctx, ev);
                } catch (e) {
                    console.error("Callback onError failed:", e);
                }
            }
        });

        socket.addEventListener("close", (ev: CloseEvent) => {
            this.connections.delete(id);

            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    cb.onClose?.(ctx, ev);
                } catch (e) {
                    console.error("Callback onClose failed:", e);
                }
            }
        });

        return response;
    }

    // --------------------
    // Send API
    // --------------------
    send(connectionId: string, data: unknown): void {
        const ctx = this.connections.get(connectionId);
        if (!ctx || !ctx.isOpen) {
            throw new Error(`JsonWebSocketServer: cannot send; connection not open: ${connectionId}`);
        }

        const encoded = (this.options.encode ?? JSON.stringify)(data);
        ctx.socket.send(encoded);
    }

    broadcast(data: unknown, filter?: (ctx: ConnectionContext) => boolean): number {
        const encoded = (this.options.encode ?? JSON.stringify)(data);

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

    closeConnection(connectionId: string, code?: number, reason?: string): boolean {
        const ctx = this.connections.get(connectionId);
        if (!ctx) return false;
        try {
            ctx.socket.close(code, reason);
            return true;
        } catch {
            return false;
        }
    }

    // --------------------
    // Optional: start/stop convenience
    // --------------------
    /**
     * Convenience for simple servers. For real apps, prefer handleRequest(req) in your router.
     */
    start(port: number, hostname = "0.0.0.0"): void {
        if (this.abort) throw new Error("JsonWebSocketServer: already started.");
        this.abort = new AbortController();

        Deno.serve(
            { port, hostname, signal: this.abort.signal },
            (req) => {
                // Only upgrade when the client asks for it
                if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
                    return new Response("Expected websocket upgrade", { status: 426 });
                }
                return this.handleRequest(req);
            },
        );
    }

    stop(code?: number, reason?: string): void {
        // Stop accepting new connections (for start())
        this.abort?.abort();
        this.abort = undefined;

        // Close existing connections
        for (const ctx of this.connections.values()) {
            try {
                ctx.socket.close(code, reason);
            } catch {
                // ignore
            }
        }
        this.connections.clear();
    }

    // --------------------
    // Helpers
    // --------------------
    private createClientId(req: Request): string {
        if (this.options.createClientId) return this.options.createClientId(req);
        // crypto.randomUUID exists in Deno
        return crypto.randomUUID();
    }
}