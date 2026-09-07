import { describe, expect, it, vi } from 'vitest';

import {
    initWsLifecycle,
    type RallarWsLifecycleCloseInput,
    type RallarWsLifecycleSocketService
} from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import { ConnectionContext, type WebSocketServerCallbacks } from '@shared/websocket/json-web-socket-server.ts';

describe('ws lifecycle service', () => {
    it('disconnects client and group session state when the websocket closes', async () => {
        const callbacks = new Map<string, WebSocketServerCallbacks>();
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
        await callbacks.get('handle-ws-lifecycle')?.onClose?.(
            createConnection('session-1', 'generation-1', 1_000),
            new CloseEvent('close')
        );
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
        const callbacks = new Map<string, WebSocketServerCallbacks>();
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

        await callbacks.get('handle-ws-lifecycle')?.onClose?.(
            createConnection('session-1', 'generation-1', 1_000),
            new CloseEvent('close')
        );
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
        const callbacks = new Map<string, WebSocketServerCallbacks>();
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

        await callbacks.get('handle-ws-lifecycle')?.onClose?.(
            createConnection('session-1', 'generation-a', 1_000),
            new CloseEvent('close')
        );
        await flushLifecycle();
        await callbacks.get('handle-ws-lifecycle')?.onClose?.(
            createConnection('session-1', 'generation-b', 1_001),
            new CloseEvent('close')
        );

        expect(captured).toEqual([1_000, 1_001]);
    });
});

function createLifecycleSocketService(
    callbacks: Map<string, WebSocketServerCallbacks>
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

function createConnection(
    id: string,
    generationId: string,
    generationStartedAtEpochMs: number
): ConnectionContext {
    return new ConnectionContext(
        { id, socket: new LifecycleTestWebSocket(), generationId, generationStartedAtEpochMs }
    );
}

class LifecycleTestWebSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://lifecycle-test';
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;

    close(): void {}

    send(): void {}
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
