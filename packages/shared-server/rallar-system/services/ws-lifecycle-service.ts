import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

export type RallarWsLifecycleHandlers = Readonly<{
    enqueueClientSessionDisconnect(
        sessionId: string,
        generationId: string,
    ): Promise<unknown>;
    enqueueGroupSessionCleanup(
        sessionId: string,
        request: Readonly<{
            actorSessionId: string;
            reason: string;
        }>,
    ): Promise<unknown>;
}>;

export function initWsLifecycle(
    wsQBoxServerService: WsQueueBoxServerService,
    handlers: RallarWsLifecycleHandlers,
): void {
    wsQBoxServerService.socket.onWebsocketCallbacksDo(
        'handle-ws-lifecycle',
        {
            onClose: async (socket) => {
                console.log(`Websocket client disconnected: ${socket.id}`);

                await Promise.all([
                    handlers.enqueueClientSessionDisconnect(
                        socket.id,
                        socket.generationId,
                    ),
                    handlers.enqueueGroupSessionCleanup(
                        socket.id,
                        {
                            actorSessionId: socket.id,
                            reason: 'socket-closed',
                        },
                    ),
                ]);
            },
        },
    );
}
