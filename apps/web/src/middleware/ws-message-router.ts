import {ALMessage, ALPayload} from "@shared/al-contracts/al-contract.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";

export type WsInboxCallback = (data: ALPayload) => Promise<void>

const webSocketInboxCallbacks = new Map<string, WsInboxCallback>();

export function addWebSocketInboxCallback(typeId: string, handler: WsInboxCallback) {
    webSocketInboxCallbacks.set(typeId, handler);
}

export function removeWebSocketInboxCallback(typeId: string) {
    webSocketInboxCallbacks.delete(typeId);
}

export function initialise(
    webSocketQueueBox: WsQueueBoxClientService
) {
    webSocketQueueBox
        .onInboxMessageDo(
            "ws-message-router",
            {
                onMessage: async (entry) => {
                    console.log(`ws-message-router: ${entry.resource}`);

                    const data = JSON.parse(entry.resource) as ALMessage;

                    const handler = webSocketInboxCallbacks.get(data.payload.typeId);

                    if (handler) {
                        await handler(data.payload);
                    } else {
                        console.warn(`No handler for typeId: ${data.payload.typeId}`);
                        console.warn(JSON.stringify(data));
                    }
                }
            }
        )
}
