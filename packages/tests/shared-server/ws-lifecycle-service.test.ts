import { describe, expect, it, vi } from 'vitest';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { initWsLifecycle } from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';

type WebSocketLifecycleCallbacks = Readonly<{
    onClose?: (socket: Readonly<{ id: string; generationId: string }>) => Promise<void>;
}>;

describe('ws lifecycle service', () => {
    it('disconnects client and group session state when the websocket closes', async () => {
        const callbacks = new Map<string, WebSocketLifecycleCallbacks>();
        const wsQBoxServerService = {
            socket: {
                onWebsocketCallbacksDo(
                    id: string,
                    callback: WebSocketLifecycleCallbacks,
                ) {
                    callbacks.set(id, callback);
                    return this;
                },
            },
        } as unknown as WsQueueBoxServerService;
        const handlers = {
            enqueueClientSessionDisconnect: vi.fn(async () => undefined),
            enqueueGroupSessionCleanup: vi.fn(async () => undefined),
        };

        initWsLifecycle(wsQBoxServerService, handlers);
        await callbacks.get('handle-ws-lifecycle')?.onClose?.({
            id: 'session-1',
            generationId: 'generation-1',
        });

        expect(handlers.enqueueClientSessionDisconnect).toHaveBeenCalledWith(
            'session-1',
            'generation-1',
        );
        expect(handlers.enqueueGroupSessionCleanup).toHaveBeenCalledWith(
            'session-1',
            {
                actorSessionId: 'session-1',
                reason: 'socket-closed',
            },
        );
    });

    it('propagates durable enqueue failure after attempting both cleanup commands', async () => {
        const callbacks = new Map<string, WebSocketLifecycleCallbacks>();
        const failure = new Error('durable client cleanup unavailable');
        const handlers = {
            enqueueClientSessionDisconnect: vi.fn(() => Promise.reject(failure)),
            enqueueGroupSessionCleanup: vi.fn(async () => undefined),
        };
        const service = {
            socket: {
                onWebsocketCallbacksDo(id: string, callback: WebSocketLifecycleCallbacks) {
                    callbacks.set(id, callback);
                },
            },
        } as unknown as WsQueueBoxServerService;
        initWsLifecycle(service, handlers);

        await expect(callbacks.get('handle-ws-lifecycle')?.onClose?.({
            id: 'session-1',
            generationId: 'generation-1',
        })).rejects.toBe(failure);
        expect(handlers.enqueueGroupSessionCleanup).toHaveBeenCalledOnce();
    });
});
