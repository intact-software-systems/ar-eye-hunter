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
  enqueueClientSessionDisconnect(input: RallarWsLifecycleCloseInput): Promise<unknown>;
  enqueueGroupSessionCleanup(input: RallarWsLifecycleCloseInput): Promise<unknown>;
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
}

export function initWsLifecycle(
  wsQBoxServerService: WsQueueBoxServerService,
  handlers: RallarWsLifecycleHandlers,
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
  const schedule = (input: RallarWsLifecycleCloseInput, attempts: number): void => {
    if (stopped) return;
    const delayIndex = Math.min(attempts - 1, handlers.retry.delaysMs.length - 1);
    const cancelScheduledRetry = handlers.retry.schedule(
      handlers.retry.delaysMs[delayIndex]!,
      async () => await writeClose(input),
    );
    pending.set(closeKey(input), { input, attempts, cancelScheduledRetry });
  };
  const writeClose = async (input: RallarWsLifecycleCloseInput): Promise<void> => {
    if (stopped || pending.get(closeKey(input))?.input !== input) return;
    const attempts = (pending.get(closeKey(input))?.attempts ?? 0) + 1;
    pending.set(closeKey(input), {
      input,
      attempts,
      cancelScheduledRetry: null,
    });
    try {
      await Promise.all([
        handlers.enqueueClientSessionDisconnect(input),
        handlers.enqueueGroupSessionCleanup(input),
      ]);
      release(input);
    } catch (error) {
      console.error('WebSocket lifecycle durable enqueue failed:', error);
      schedule(input, attempts);
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
    if (existing || [...pending.values()].some((candidate) =>
      candidate.input.sessionId === input.sessionId &&
      compareGeneration(candidate.input, input) > 0
    )) {
      if (!existing) handlers.releaseCloseFacts(input);
      return;
    }
    pending.set(closeKey(input), { input, attempts: 0, cancelScheduledRetry: null });
    void writeClose(input);
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
          socket.generationStartedAtEpochMs,
        ),
        reason: 'socket-closed',
      });
    },
  });

  return {
    getPendingCloseCount: () => pending.size,
    retryPending: async () => {
      await Promise.all([...pending.values()].map(async (entry) => {
        entry.cancelScheduledRetry?.();
        await writeClose(entry.input);
      }));
    },
    stop: () => {
      stopped = true;
      for (const entry of [...pending.values()]) release(entry.input);
      wsQBoxServerService.socket.removeWebsocketCallbackById('handle-ws-lifecycle');
    },
  };
}

export function scheduleWsLifecycleRetry(
  delayMs: number,
  retry: () => Promise<void>,
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
  right: Pick<RallarWsLifecycleCloseInput, 'generationStartedAtEpochMs' | 'generationId'>,
): number {
  return left.generationStartedAtEpochMs - right.generationStartedAtEpochMs ||
    left.generationId.localeCompare(right.generationId);
}

function closeKey(input: RallarWsLifecycleCloseInput): string {
  return [input.sessionId, input.generationId].map(encodeURIComponent).join(':');
}
