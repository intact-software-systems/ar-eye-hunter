import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

export type RallarWsLifecycleCloseInput = Readonly<{
  sessionId: string;
  generationId: string;
  generationStartedAtEpochMs: number;
  disconnectedAtEpochMs: number;
  reason: string;
}>;

export type RallarWsLifecycleHandlers = Readonly<{
  now(): number;
  enqueueClientSessionDisconnect(
    input: RallarWsLifecycleCloseInput,
  ): Promise<unknown>;
  enqueueGroupSessionCleanup(
    input: RallarWsLifecycleCloseInput,
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
        const input: RallarWsLifecycleCloseInput = {
          sessionId: socket.id,
          generationId: socket.generationId,
          generationStartedAtEpochMs: socket.generationStartedAtEpochMs,
          disconnectedAtEpochMs: handlers.now(),
          reason: 'socket-closed',
        };

        await Promise.all([
          handlers.enqueueClientSessionDisconnect(input),
          handlers.enqueueGroupSessionCleanup(input),
        ]);
      },
    },
  );
}
