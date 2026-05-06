import { describe, expect, it, vi } from 'vitest';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { initWsLifecycle } from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';

type WebSocketLifecycleCallbacks = Readonly<{
    onClose?: (socket: Readonly<{ id: string }>) => Promise<void>;
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
            disconnectClientSession: vi.fn(async () => undefined),
            disconnectGroupSessionsBySessionId: vi.fn(async () => undefined),
        };

        initWsLifecycle(wsQBoxServerService, handlers);
        await callbacks.get('handle-ws-lifecycle')?.onClose?.({ id: 'session-1' });

        expect(handlers.disconnectClientSession).toHaveBeenCalledWith('session-1');
        expect(handlers.disconnectGroupSessionsBySessionId).toHaveBeenCalledWith(
            'session-1',
            {
                actorSessionId: 'session-1',
                reason: 'socket-closed',
            },
        );
    });
});
