import { initWsLifecycle } from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { describe, expect, it, vi } from 'vitest';

type WebSocketLifecycleCallbacks = Readonly<{
    onClose?: (
        socket: Readonly<{
            id: string;
            generationId: string;
            generationStartedAtEpochMs: number;
        }>
    ) => void | Promise<void>;
}>;

describe('ws lifecycle service', () => {
    it('disconnects client and group session state when the websocket closes', async () => {
        const callbacks = new Map<string, WebSocketLifecycleCallbacks>();
        const wsQBoxServerService = {
            socket: {
                onWebsocketCallbacksDo(
                    id: string,
                    callback: WebSocketLifecycleCallbacks
                ) {
                    callbacks.set(id, callback);
                    return this;
                }
            }
        } as unknown as WsQueueBoxServerService;
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
        const handlers = {
            now: () => 2_000,
            enqueueClientSessionDisconnect: vi.fn(() => Promise.reject(failure)),
            enqueueGroupSessionCleanup: vi.fn(() => Promise.resolve()),
            hasCloseFacts: () => true,
            releaseCloseFacts: vi.fn(),
            retry: retryConfig(scheduled)
        };
        const service = {
            socket: {
                onWebsocketCallbacksDo(id: string, callback: WebSocketLifecycleCallbacks) {
                    callbacks.set(id, callback);
                }
            }
        } as unknown as WsQueueBoxServerService;
        initWsLifecycle(service, handlers);

        await callbacks.get('handle-ws-lifecycle')?.onClose?.({
            id: 'session-1',
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000
        });
        await flushLifecycle();
        expect(handlers.enqueueGroupSessionCleanup).toHaveBeenCalledOnce();
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
        const service = {
            socket: {
                onWebsocketCallbacksDo(id: string, callback: WebSocketLifecycleCallbacks) {
                    callbacks.set(id, callback);
                }
            }
        } as unknown as WsQueueBoxServerService;
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
