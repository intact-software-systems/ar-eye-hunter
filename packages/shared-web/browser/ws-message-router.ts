import { ALMessage, ALPayload } from '@shared/al-contracts/al-contract.ts';
import { getMiddleware } from '@shared-web/browser/app-context.ts';

export type WsInboxCallback = (data: ALPayload) => Promise<void>

export function addWebSocketInboxCallback(
    typeId: string,
    handler: WsInboxCallback
) {
    getMiddleware().middleware
        .webSocketQueueBox.onInboxMessageDo(
        typeId,
        {
            onMessage: async (data: ALMessage) => {
                await handler(data.payload);
            }
        }
    );
}

export function removeWebSocketInboxCallback(typeId: string) {
    getMiddleware().middleware
        .webSocketQueueBox.removeInboxMessageCallback(typeId);
}
