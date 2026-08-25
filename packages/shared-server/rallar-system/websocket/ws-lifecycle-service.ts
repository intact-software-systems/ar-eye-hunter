import type { WebSocketServerCallbacks } from '@shared/websocket/JsonWebSocketServer.ts';

export interface RallarWsLifecycleCloseInput {
    readonly sessionId: string;
    readonly generationId: string;
    readonly generationStartedAtEpochMs: number;
    readonly disconnectedAtEpochMs: number;
    readonly reason: string;
}

export interface RallarWsLifecycleRetryConfig {
    readonly delaysMs: readonly number[];
    schedule(delayMs: number, retry: () => Promise<void>): () => void;
}

export interface RallarWsLifecycleHandlers {
    now(): number;
    enqueueClientSessionDisconnect(input: RallarWsLifecycleCloseInput): Promise<void>;
    enqueueGroupSessionCleanup(input: RallarWsLifecycleCloseInput): Promise<void>;
    hasCloseFacts(input: RallarWsLifecycleCloseInput): boolean;
    releaseCloseFacts(input: RallarWsLifecycleCloseInput): void;
    readonly retry: RallarWsLifecycleRetryConfig;
}

export interface RallarWsLifecycleRuntime {
    getPendingCloseCount(): number;
    retryPending(): Promise<void>;
    stop(): void;
}

export interface RallarWsLifecycleSocketService {
    readonly socket: {
        onWebsocketCallbacksDo(id: string, callbacks: WebSocketServerCallbacks): void;
        removeWebsocketCallbackById(id: string): boolean;
    };
}

interface PendingClose {
    readonly input: RallarWsLifecycleCloseInput;
    readonly attempts: number;
    readonly cancelScheduledRetry: (() => void) | null;
    readonly token: object;
}

const WS_LIFECYCLE_CALLBACK_ID = 'handle-ws-lifecycle';

export function initWsLifecycle(
    wsQBoxServerService: RallarWsLifecycleSocketService,
    handlers: RallarWsLifecycleHandlers
): RallarWsLifecycleRuntime {
    return new WsLifecycleCloseRuntime(wsQBoxServerService, handlers);
}

class WsLifecycleCloseRuntime implements RallarWsLifecycleRuntime {
    private readonly wsQBoxServerService: RallarWsLifecycleSocketService;
    private readonly handlers: RallarWsLifecycleHandlers;
    private readonly pending = new Map<string, PendingClose>();
    private stopped = false;

    constructor(
        wsQBoxServerService: RallarWsLifecycleSocketService,
        handlers: RallarWsLifecycleHandlers
    ) {
        this.wsQBoxServerService = wsQBoxServerService;
        this.handlers = handlers;
        validateRetryConfig(handlers.retry);
        wsQBoxServerService.socket.onWebsocketCallbacksDo(WS_LIFECYCLE_CALLBACK_ID, {
            onClose: (socket) => {
                console.log(`Websocket client disconnected: ${socket.id}`);
                this.observeClose({
                    sessionId: socket.id,
                    generationId: socket.generationId,
                    generationStartedAtEpochMs: socket.generationStartedAtEpochMs,
                    disconnectedAtEpochMs: Math.max(
                        handlers.now(),
                        socket.generationStartedAtEpochMs
                    ),
                    reason: 'socket-closed'
                });
            }
        });
    }

    getPendingCloseCount(): number {
        return this.pending.size;
    }

    async retryPending(): Promise<void> {
        await Promise.all([...this.pending.values()].map(async (entry) => {
            entry.cancelScheduledRetry?.();
            await this.writeClose(entry.input, entry.token);
        }));
    }

    stop(): void {
        this.stopped = true;
        for (const entry of [...this.pending.values()]) {
            this.release(entry.input);
        }
        this.wsQBoxServerService.socket.removeWebsocketCallbackById(WS_LIFECYCLE_CALLBACK_ID);
    }

    private observeClose(input: RallarWsLifecycleCloseInput): void {
        for (const existing of [...this.pending.values()]) {
            if (
                existing.input.sessionId === input.sessionId &&
                compareGeneration(existing.input, input) < 0
            ) {
                this.release(existing.input);
            }
        }
        const existing = this.pending.get(closeKey(input));
        if (existing || this.hasNewerGeneration(input)) {
            if (!existing) {
                this.handlers.releaseCloseFacts(input);
            }
            return;
        }
        const entry: PendingClose = {
            input,
            attempts: 0,
            cancelScheduledRetry: null,
            token: {}
        };
        this.pending.set(closeKey(input), entry);
        void this.writeClose(input, entry.token);
    }

    private hasNewerGeneration(input: RallarWsLifecycleCloseInput): boolean {
        return [...this.pending.values()].some((candidate) =>
            candidate.input.sessionId === input.sessionId &&
            compareGeneration(candidate.input, input) > 0
        );
    }

    private async writeClose(
        input: RallarWsLifecycleCloseInput,
        token: object
    ): Promise<void> {
        const current = this.pending.get(closeKey(input));
        if (
            this.stopped || current?.token !== token ||
            !this.handlers.hasCloseFacts(input)
        ) {
            return;
        }
        const attempted: PendingClose = {
            input,
            attempts: current.attempts + 1,
            cancelScheduledRetry: null,
            token
        };
        this.pending.set(closeKey(input), attempted);
        try {
            await Promise.all([
                this.handlers.enqueueClientSessionDisconnect(input),
                this.handlers.enqueueGroupSessionCleanup(input)
            ]);
            this.release(input);
        }
        catch (error) {
            console.error('WebSocket lifecycle durable enqueue failed:', error);
            this.schedule(attempted);
        }
    }

    private schedule(entry: PendingClose): void {
        const current = this.pending.get(closeKey(entry.input));
        if (
            this.stopped || current?.token !== entry.token ||
            !this.handlers.hasCloseFacts(entry.input)
        ) {
            return;
        }
        const delayIndex = Math.min(
            entry.attempts - 1,
            this.handlers.retry.delaysMs.length - 1
        );
        const cancelScheduledRetry = this.handlers.retry.schedule(
            this.handlers.retry.delaysMs[delayIndex]!,
            async () => await this.writeClose(entry.input, entry.token)
        );
        this.pending.set(closeKey(entry.input), { ...entry, cancelScheduledRetry });
    }

    private release(input: RallarWsLifecycleCloseInput): void {
        const existing = this.pending.get(closeKey(input));
        existing?.cancelScheduledRetry?.();
        this.pending.delete(closeKey(input));
        this.handlers.releaseCloseFacts(input);
    }
}

export function scheduleWsLifecycleRetry(
    delayMs: number,
    retry: () => Promise<void>
): () => void {
    const timer = setTimeout(() => void retry(), delayMs);
    return () => clearTimeout(timer);
}

function validateRetryConfig(config: RallarWsLifecycleRetryConfig): void {
    if (
        config.delaysMs.length === 0 ||
        config.delaysMs.some((delayMs) => !Number.isSafeInteger(delayMs) || delayMs < 1)
    ) {
        throw new TypeError('WebSocket lifecycle retry delays are invalid');
    }
}

function compareGeneration(
    left: Pick<RallarWsLifecycleCloseInput, 'generationStartedAtEpochMs' | 'generationId'>,
    right: Pick<RallarWsLifecycleCloseInput, 'generationStartedAtEpochMs' | 'generationId'>
): number {
    return left.generationStartedAtEpochMs - right.generationStartedAtEpochMs ||
        left.generationId.localeCompare(right.generationId);
}

function closeKey(input: RallarWsLifecycleCloseInput): string {
    return [input.sessionId, input.generationId].map(encodeURIComponent).join(':');
}
