import {webSocketQueueBox} from "./websocket-engine.ts";
import {ALMessage, ALPayload} from "@shared/al-contracts/al-contract.ts";

const webSocketInboxCallbacks = new Map<string, (data: ALPayload) => void>();

export function addWebSocketInboxCallback(typeId: string, handler: (data: ALPayload) => void) {
    webSocketInboxCallbacks.set(typeId, handler);
}

export function removeWebSocketInboxCallback(typeId: string) {
    webSocketInboxCallbacks.delete(typeId);
}

webSocketQueueBox
    .onInboxMessageDo(
        "websocket-data-router",
        {
            onMessage: async (entry) => {
                console.log(`websocket-data-router: ${entry.resource}`);

                const data = JSON.parse(entry.resource) as ALMessage;

                const handler = webSocketInboxCallbacks.get(data.payload.typeId);

                if (handler) {
                    handler(data.payload);
                    return;
                } else {
                    console.warn(`No handler for typeId: ${data.payload.typeId}`);
                    console.warn(JSON.stringify(data));
                }

                // TODO: Add handler to log all websocket data to a UI
            }
        }
    )
