import {
    initWsLifecycle,
    type RallarWsLifecycleCloseInput,
    type RallarWsLifecycleSocketService
} from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import { describe, expect, it, vi } from 'vitest';

interface WebSocketLifecycleCallbacks {
    onClose?: (socket: WebSocketLifecycleSocket) => void | Promise<void>;
}

interface WebSocketLifecycleSocket {
    readonly id: string;
    readonly generationId: string;
    readonly generationStartedAtEpochMs: number;
}

describe('ws lifecycle service', () => {
    it('disconnects client and group session state when the websocket closes', async () => {
        const callbacks = new Map<string, WebSocketLifecycleCallbacks>();
        const wsQBoxServerService = createLifecycleSocketService(callbacks);
        const handlers = {
            now: () => 2_000,
            enqueueClientSessionDisconnect: vi.fn(() => Promise.resolve()),
            enqueueGroupSessionCleanup: vi.fn(() => Promise.resolve()),
            hasCloseFacts: () => true,
            releaseCloseFacts: vi.fn(),
            retry: retryConfig()
        };

        initWsLifecycle(wsQBoxServerService, handlers);
        await callbacks.get('handle-ws-lifecycle')?.onClose?.({
            id: 'session-1',
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000
        });
        await flushLifecycle();

        const closeFacts = {
            sessionId: 'session-1',
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000,
            disconnectedAtEpochMs: 2_000,
            reason: 'socket-closed'
        };
        expect(handlers.enqueueClientSessionDisconnect).toHaveBeenCalledWith(closeFacts);
        expect(handlers.enqueueGroupSessionCleanup).toHaveBeenCalledWith(closeFacts);
    });

    it('schedules durable enqueue failure after attempting both cleanup commands', async () => {
        const callbacks = new Map<string, WebSocketLifecycleCallbacks>();
        const failure = new Error('durable client cleanup unavailable');
        const scheduled: Array<() => Promise<void>> = [];
        const groupCleanupInputs: RallarWsLifecycleCloseInput[] = [];
        const handlers = {
            now: () => 2_000,
            enqueueClientSessionDisconnect: vi.fn(() => Promise.reject(failure)),
            enqueueGroupSessionCleanup: (input: RallarWsLifecycleCloseInput) => {
                groupCleanupInputs.push(input);
                return Promise.resolve();
            },
            hasCloseFacts: () => true,
            releaseCloseFacts: vi.fn(),
            retry: retryConfig(scheduled)
        };
        const service = createLifecycleSocketService(callbacks);
        initWsLifecycle(service, handlers);

        await callbacks.get('handle-ws-lifecycle')?.onClose?.({
            id: 'session-1',
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000
        });
        await flushLifecycle();
        expect(groupCleanupInputs).toEqual([{
            sessionId: 'session-1',
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000,
            disconnectedAtEpochMs: 2_000,
            reason: 'socket-closed'
        }]);
        expect(scheduled).toHaveLength(1);
    });

    it('clamps close capture time to each monotonic websocket generation start', async () => {
        const callbacks = new Map<string, WebSocketLifecycleCallbacks>();
        const captured: number[] = [];
        const handlers = {
            now: () => 900,
            enqueueClientSessionDisconnect: vi.fn((input: { disconnectedAtEpochMs: number; }) => {
                captured.push(input.disconnectedAtEpochMs);
                return Promise.resolve();
            }),
            enqueueGroupSessionCleanup: vi.fn(() => Promise.resolve()),
            hasCloseFacts: () => true,
            releaseCloseFacts: vi.fn(),
            retry: retryConfig()
        };
        const service = createLifecycleSocketService(callbacks);
        initWsLifecycle(service, handlers);

        await callbacks.get('handle-ws-lifecycle')?.onClose?.({
            id: 'session-1',
            generationId: 'generation-a',
            generationStartedAtEpochMs: 1_000
        });
        await flushLifecycle();
        await callbacks.get('handle-ws-lifecycle')?.onClose?.({
            id: 'session-1',
            generationId: 'generation-b',
            generationStartedAtEpochMs: 1_001
        });

        expect(captured).toEqual([1_000, 1_001]);
    });
});

function createLifecycleSocketService(
    callbacks: Map<string, WebSocketLifecycleCallbacks>
): RallarWsLifecycleSocketService {
    return {
        socket: {
            onWebsocketCallbacksDo: (id, callback) => {
                callbacks.set(id, callback);
            },
            removeWebsocketCallbackById: (id) => callbacks.delete(id)
        }
    };
}

function retryConfig(scheduled: Array<() => Promise<void>> = []) {
    return {
        delaysMs: [1],
        schedule: (_delayMs: number, retry: () => Promise<void>) => {
            scheduled.push(retry);
            return () => undefined;
        }
    };
}

async function flushLifecycle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
