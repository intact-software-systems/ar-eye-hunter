import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

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

interface PendingClose {
    readonly input: RallarWsLifecycleCloseInput;
    readonly attempts: number;
    readonly cancelScheduledRetry: (() => void) | null;
    readonly token: object;
}

export function initWsLifecycle(
    wsQBoxServerService: WsQueueBoxServerService,
    handlers: RallarWsLifecycleHandlers
): RallarWsLifecycleRuntime {
    validateRetryConfig(handlers.retry);
    const pending = new Map<string, PendingClose>();
    let stopped = false;

    const release = (input: RallarWsLifecycleCloseInput): void => {
        const existing = pending.get(closeKey(input));
        existing?.cancelScheduledRetry?.();
        pending.delete(closeKey(input));
        handlers.releaseCloseFacts(input);
    };
    const schedule = (entry: PendingClose): void => {
        const current = pending.get(closeKey(entry.input));
        if (
            stopped || current?.token !== entry.token ||
            !handlers.hasCloseFacts(entry.input)
        ) {
            return;
        }
        const attempts = entry.attempts;
        const delayIndex = Math.min(attempts - 1, handlers.retry.delaysMs.length - 1);
        const cancelScheduledRetry = handlers.retry.schedule(
            handlers.retry.delaysMs[delayIndex]!,
            async () => await writeClose(entry.input, entry.token)
        );
        pending.set(closeKey(entry.input), { ...entry, cancelScheduledRetry });
    };
    const writeClose = async (
        input: RallarWsLifecycleCloseInput,
        token: object
    ): Promise<void> => {
        const current = pending.get(closeKey(input));
        if (stopped || current?.token !== token || !handlers.hasCloseFacts(input)) {
            return;
        }
        const attempted: PendingClose = {
            input,
            attempts: current.attempts + 1,
            cancelScheduledRetry: null,
            token
        };
        pending.set(closeKey(input), attempted);
        try {
            await Promise.all([
                handlers.enqueueClientSessionDisconnect(input),
                handlers.enqueueGroupSessionCleanup(input)
            ]);
            release(input);
        }
        catch (error) {
            console.error('WebSocket lifecycle durable enqueue failed:', error);
            schedule(attempted);
        }
    };
    const observeClose = (input: RallarWsLifecycleCloseInput): void => {
        for (const existing of [...pending.values()]) {
            if (
                existing.input.sessionId === input.sessionId &&
                compareGeneration(existing.input, input) < 0
            ) {
                release(existing.input);
            }
        }
        const existing = pending.get(closeKey(input));
        if (
            existing ||
            [...pending.values()].some((candidate) =>
                candidate.input.sessionId === input.sessionId &&
                compareGeneration(candidate.input, input) > 0
            )
        ) {
            if (!existing) {
                handlers.releaseCloseFacts(input);
            }
            return;
        }
        const entry: PendingClose = {
            input,
            attempts: 0,
            cancelScheduledRetry: null,
            token: {}
        };
        pending.set(closeKey(input), entry);
        void writeClose(input, entry.token);
    };

    wsQBoxServerService.socket.onWebsocketCallbacksDo('handle-ws-lifecycle', {
        onClose: (socket) => {
            console.log(`Websocket client disconnected: ${socket.id}`);
            observeClose({
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

    return {
        getPendingCloseCount: () => pending.size,
        retryPending: async () => {
            await Promise.all([...pending.values()].map(async (entry) => {
                entry.cancelScheduledRetry?.();
                await writeClose(entry.input, entry.token);
            }));
        },
        stop: () => {
            stopped = true;
            for (const entry of [...pending.values()]) {
                release(entry.input);
            }
            wsQBoxServerService.socket.removeWebsocketCallbackById('handle-ws-lifecycle');
        }
    };
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
