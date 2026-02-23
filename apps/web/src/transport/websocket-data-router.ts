import {webSocketQueueBox} from "./websocket-engine.ts";

const websocketDataHandlers = new Map<string, (data: any) => void>();

addWebSocketDataRouter();

export function addWebSocketDataRouter() {
    webSocketQueueBox
        .onInboxMessageDo(
            "websocket-data-router",
            {
                onMessage: async (entry) => {
                    console.log(`websocket-data-router: ${entry.resource}`);

                    // TODO: route to correct handler but how?
                    const data = JSON.parse(entry.resource);

                    for (const handler of websocketDataHandlers.values()) {
                        try {
                            handler(data);
                        } catch (e) {
                            console.error(`Error handling websocket data: ${e}`);
                        }
                    }
                }
            }
        )

}

export function addWebSocketDataHandler(typeId: string, handler: (data: any) => void) {
    websocketDataHandlers.set(typeId, handler);
}

export function removeWebSocketDataHandler(typeId: string) {
    websocketDataHandlers.delete(typeId);
}
