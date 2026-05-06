import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

export type RallarWsLifecycleHandlers = Readonly<{
    disconnectClientSession(sessionId: string): Promise<unknown>;
    disconnectGroupSessionsBySessionId(
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

                try {
                    await handlers.disconnectClientSession(socket.id);
                } catch (error) {
                    console.warn(
                        'Failed to update client session state on disconnect:',
                        error,
                    );
                }

                try {
                    await handlers.disconnectGroupSessionsBySessionId(
                        socket.id,
                        {
                            actorSessionId: socket.id,
                            reason: 'socket-closed',
                        },
                    );
                } catch (error) {
                    console.warn(
                        'Failed to update group presence state on disconnect:',
                        error,
                    );
                }
            },
        },
    );
}
