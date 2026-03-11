import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { getClientStateService } from './client-state-service.ts';
import { getGroupStateService } from './group-state-service.ts';

export function initWsLifecycle(
    wsQBoxServerService: WsQueueBoxServerService,
): void {
    wsQBoxServerService.socket.onWebsocketCallbacksDo(
        'handle-ws-lifecycle',
        {
            onClose: async (socket) => {
                console.log(`Websocket client disconnected: ${socket.id}`);

                try {
                    await getClientStateService().disconnectAuthorisedWsClientSession(
                        socket.id,
                    );
                } catch (error) {
                    console.warn(
                        'Failed to update client session state on disconnect:',
                        error,
                    );
                }

                try {
                    await getGroupStateService().disconnectPresenceSessionsBySessionId(
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
