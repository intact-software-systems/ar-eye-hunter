import { validateJsonMessageSize, type JsonMessageRejection } from '../api/json-message-validation.ts';

export interface WebSocketServerCallbacks {
    onConnection?: (ctx: ConnectionContext) => void;
    onError?: (ctx: ConnectionContext, ev: Event) => void;
    onClose?: (ctx: ConnectionContext, ev: CloseEvent) => void | Promise<void>;

    /**
     * Called when a client sends non-JSON text (JSON.parse fails).
     * You can omit this if you want to ignore parse errors.
     */
    onParseError?: (ctx: ConnectionContext, rawText: string, error: unknown) => void;
}

export interface WebSocketServerOnMessageCallback {
    readonly maxMessageBytes?: number;
    onRejected?: (ctx: ConnectionContext, reason: JsonMessageRejection, ev: MessageEvent) => Promise<void>;
    onMessage: (ctx: ConnectionContext, data: unknown, ev: MessageEvent) => Promise<void>;
}

export interface EncodedJsonWebSocketMessage {
    readonly text: string;
}

export namespace ConnectionContext {
    export interface Input {
        readonly id: string;
        readonly socket: WebSocket;
        readonly generationId?: string;
        readonly generationStartedAtEpochMs?: number;
    }
}

export class ConnectionContext {
    public readonly id: string;
    public readonly socket: WebSocket;
    public readonly generationId: string;
    public readonly generationStartedAtEpochMs: number;

    constructor(input: ConnectionContext.Input) {
        this.id = input.id;
        this.socket = input.socket;
        this.generationId = input.generationId ?? crypto.randomUUID();
        this.generationStartedAtEpochMs = input.generationStartedAtEpochMs ?? Date.now();
    }

    get isOpen(): boolean {
        return this.socket.readyState === WebSocket.OPEN;
    }
}

export namespace JsonWebSocketServer {
    /** Private caller-owned capture buffer; the native boundary never invokes a diagnostic sink. */
    export interface SendEvidence {
        nativeCall: 'not-called' | 'invoked' | 'returned';
    }

    export interface CreateConnectionInput extends MintGenerationInput {
        readonly id: string;
        readonly socket: WebSocket;
    }

    export interface MintGenerationInput {
        readonly generationId?: string;
        readonly observedAtEpochMs?: number;
    }

    export interface ConnectionGeneration {
        readonly generationId: string;
        readonly generationStartedAtEpochMs: number;
    }

    /** A generation admitted before its socket exists; sends addressed to its id wait until it opens or settles. */
    export interface ExpectedConnection {
        readonly id: string;
        readonly generationId: string;
    }
}

interface ExpectedConnectionHold {
    readonly generationIds: Set<string>;
    readonly deferredSends: Array<() => void>;
}

export class JsonWebSocketServer {
    public static readonly MAX_DEFERRED_SENDS_PER_CONNECTION = 64;

    private readonly webSocketServerCallbacks = new Map<string, WebSocketServerCallbacks>();
    private readonly onMessageCallbacks = new Map<string, WebSocketServerOnMessageCallback>();
    private readonly expectedConnections = new Map<string, ExpectedConnectionHold>();
    private lastGenerationStartedAtEpochMs = -1;

    public readonly connections = new Map<string, ConnectionContext>();

    createConnectionContext(input: JsonWebSocketServer.CreateConnectionInput): ConnectionContext {
        return new ConnectionContext({
            id: input.id,
            socket: input.socket,
            ...this.mintConnectionGeneration(input)
        });
    }

    mintConnectionGeneration(
        input: JsonWebSocketServer.MintGenerationInput = {}
    ): JsonWebSocketServer.ConnectionGeneration {
        const generationId = input.generationId ?? crypto.randomUUID();
        const observedAtEpochMs = input.observedAtEpochMs ?? Date.now();
        if (!Number.isSafeInteger(observedAtEpochMs) || observedAtEpochMs < 0) {
            throw new TypeError('WebSocket generation start must be a non-negative safe integer');
        }
        if (this.lastGenerationStartedAtEpochMs === Number.MAX_SAFE_INTEGER) {
            throw new Error('WebSocket generation clock exhausted');
        }
        const generationStartedAtEpochMs = Math.max(
            observedAtEpochMs,
            this.lastGenerationStartedAtEpochMs + 1
        );
        this.lastGenerationStartedAtEpochMs = generationStartedAtEpochMs;
        return { generationId, generationStartedAtEpochMs };
    }

    // --------------------
    // Expected connections
    // --------------------

    expectConnection(expected: JsonWebSocketServer.ExpectedConnection): void {
        const hold = this.expectedConnections.get(expected.id) ?? { generationIds: new Set(), deferredSends: [] };
        hold.generationIds.add(expected.generationId);
        this.expectedConnections.set(expected.id, hold);
    }

    /** The last expected generation of an id to settle runs its held sends, which then find whatever is open. */
    releaseExpectedConnection(expected: JsonWebSocketServer.ExpectedConnection): void {
        const hold = this.expectedConnections.get(expected.id);
        if (!hold?.generationIds.delete(expected.generationId) || hold.generationIds.size > 0) {
            return;
        }
        this.expectedConnections.delete(expected.id);
        runDeferredSends(hold.deferredSends);
    }

    isAwaitingConnection(id: string): boolean {
        return this.expectedConnections.has(id) && this.connections.get(id)?.isOpen !== true;
    }

    deferUntilConnectionSettles(id: string, send: () => void): boolean {
        const hold = this.expectedConnections.get(id);
        if (
            hold === undefined || !this.isAwaitingConnection(id) ||
            hold.deferredSends.length >= JsonWebSocketServer.MAX_DEFERRED_SENDS_PER_CONNECTION
        ) {
            return false;
        }
        hold.deferredSends.push(send);
        return true;
    }

    private openExpectedConnection(ctx: ConnectionContext): void {
        const hold = this.expectedConnections.get(ctx.id);
        if (!hold?.generationIds.delete(ctx.generationId)) {
            return;
        }
        if (hold.generationIds.size === 0) {
            this.expectedConnections.delete(ctx.id);
        }
        runDeferredSends(hold.deferredSends.splice(0));
    }

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
        const existing = this.connections.get(ctx.id);
        this.connections.set(ctx.id, ctx);

        this.addAllEventListeners(ctx);
        if (existing && existing !== ctx) {
            this.closeContext(existing, 1000, 'connection-replaced');
        }
    }

    private addAllEventListeners(ctx: ConnectionContext) {
        ctx.socket.addEventListener('open', (_: Event) => {
            this.openExpectedConnection(ctx);
            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    cb.onConnection?.(ctx);
                }
                catch (e) {
                    console.error('Callback onConnection failed:', e);
                }
            }
        });

        ctx.socket.addEventListener('message', (event: MessageEvent) => this.dispatchMessage(ctx, event));

        ctx.socket.addEventListener('error', (ev: Event) => {
            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    cb.onError?.(ctx, ev);
                }
                catch (e) {
                    console.error('Callback onError failed:', e);
                }
            }
        });

        ctx.socket.addEventListener('close', (ev: CloseEvent) => {
            if (this.connections.get(ctx.id) === ctx) {
                this.connections.delete(ctx.id);
            }
            this.releaseExpectedConnection({ id: ctx.id, generationId: ctx.generationId });

            for (const cb of this.webSocketServerCallbacks.values()) {
                try {
                    const completion = cb.onClose?.(ctx, ev);
                    if (completion) {
                        void Promise.resolve(completion).catch((error) => {
                            console.error('Callback onClose failed:', error);
                        });
                    }
                }
                catch (e) {
                    console.error('Callback onClose failed:', e);
                }
            }
        });
    }

    private async dispatchMessage(ctx: ConnectionContext, event: MessageEvent): Promise<void> {
        if (this.connections.get(ctx.id) !== ctx) {
            return;
        }
        if (this.onMessageCallbacks.size === 0) {
            this.decodeMessage(ctx, event);
            return;
        }
        let decoded: unknown = event.data;
        let hasDecoded = false;
        for (const callback of this.onMessageCallbacks.values()) {
            if (this.connections.get(ctx.id) !== ctx) {
                return;
            }
            try {
                if (callback.maxMessageBytes !== undefined) {
                    const validated = validateJsonMessageSize(event.data, callback.maxMessageBytes);
                    if (validated.left) {
                        await callback.onRejected?.(ctx, validated.left, event);
                        continue;
                    }
                }
                if (!hasDecoded) {
                    decoded = this.decodeMessage(ctx, event);
                    hasDecoded = true;
                }
                await callback.onMessage(ctx, decoded, event);
            }
            catch (error) {
                console.error('Callback onMessage failed:', error);
            }
        }
    }

    private decodeMessage(ctx: ConnectionContext, event: MessageEvent): unknown {
        if (typeof event.data !== 'string') {
            return event.data;
        }
        try {
            return JSON.parse(event.data);
        }
        catch (error) {
            for (const callback of this.webSocketServerCallbacks.values()) {
                try {
                    callback.onParseError?.(ctx, event.data, error);
                }
                catch (callbackError) {
                    console.error('Callback onParseError failed:', callbackError);
                }
            }
            return event.data;
        }
    }

    closeConnection(connectionId: string, code?: number, reason?: string): boolean {
        const ctx = this.connections.get(connectionId);
        if (!ctx) {
            return false;
        }

        this.closeContext(ctx, code, reason);
        return true;
    }

    private closeContext(ctx: ConnectionContext, code?: number, reason?: string): void {
        if (ctx.socket.readyState === WebSocket.CLOSING || ctx.socket.readyState === WebSocket.CLOSED) {
            return;
        }

        ctx.socket.close(code, reason);
    }

    // --------------------
    // Send API
    // --------------------

    send(connectionId: string, data: unknown): void {
        this.sendEncoded(connectionId, this.encode(data));
    }

    encode(data: unknown): EncodedJsonWebSocketMessage {
        return {
            text: JSON.stringify(data)
        };
    }

    sendEncoded(
        connectionId: string,
        encoded: EncodedJsonWebSocketMessage,
        evidence?: JsonWebSocketServer.SendEvidence
    ): void {
        const ctx = this.connections.get(connectionId);
        if (!ctx || !ctx.isOpen) {
            throw new Error(`JsonWebSocketServer: cannot send; connection not open: ${connectionId}`);
        }

        // Preserve receiver, method and argument evaluation before stating actual invocation.
        const socket = ctx.socket;
        const send = socket.send;
        const text = encoded.text;
        if (evidence !== undefined) {
            evidence.nativeCall = 'invoked';
        }
        send.call(socket, text);
        if (evidence !== undefined) {
            evidence.nativeCall = 'returned';
        }
    }

    trySendEncoded(connectionId: string, encoded: EncodedJsonWebSocketMessage): boolean {
        const ctx = this.connections.get(connectionId);
        if (!ctx?.isOpen) {
            return false;
        }

        try {
            ctx.socket.send(encoded.text);
            return true;
        }
        catch (error) {
            console.error(`WebSocket send failed for ${connectionId}`, error);
            return false;
        }
    }

    trySendEncodedToContext(
        context: ConnectionContext,
        encoded: EncodedJsonWebSocketMessage
    ): boolean {
        if (this.connections.get(context.id) !== context || !context.isOpen) {
            return false;
        }

        try {
            context.socket.send(encoded.text);
            return true;
        }
        catch (error) {
            console.error(`WebSocket send failed for ${context.id}`, error);
            return false;
        }
    }

    broadcast(data: unknown, filter?: (ctx: ConnectionContext) => boolean): number {
        const encoded = this.encode(data);

        let count = 0;
        for (const ctx of this.connections.values()) {
            if (!ctx.isOpen) {
                continue;
            }
            if (filter && !filter(ctx)) {
                continue;
            }

            try {
                ctx.socket.send(encoded.text);
                count += 1;
            }
            catch (e) {
                console.error('Broadcast send failed:', e);
            }
        }
        return count;
    }
}

function runDeferredSends(sends: readonly (() => void)[]): void {
    for (const send of sends) {
        try {
            send();
        }
        catch (error) {
            console.error('Deferred WebSocket send failed:', error);
        }
    }
}
