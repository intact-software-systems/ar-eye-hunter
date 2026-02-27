import {ChatScreen} from "./chat-screen.ts";
import {ALPayload, toALMessage} from "@shared/al-contracts/al-contract.ts";
import {webSocketClientId, webSocketQueueBox} from "../transport/websocket-engine.ts";
import {addWebSocketInboxCallback} from "../transport/websocket-data-router.ts";

export function initialiseChatTransport(
    chat: ChatScreen,
    typeId: string
) {
    chat.configure({
        onSend: async (text) => {

            const message =
                toALMessage(
                    webSocketClientId,
                    typeId,
                    {
                        clientId: webSocketClientId,
                        message: text
                    }
                );

            console.log(`Sending message: ` + JSON.stringify(message));

            await webSocketQueueBox.enqueueOutboxIfAbsent(message)
        },
        onReady: (api) => {
            api.addMessage({role: 'peer', text: 'Connected.'});
        }
    });

    addWebSocketInboxCallback(
        typeId,
        (payload: ALPayload) => {
            const data = JSON.parse(payload.resource);
            console.log(`Received message: ` + JSON.stringify(data));

            if (data.message === undefined) {
                console.error('Invalid message received from server');
                return;
            }
            if (data.clientId === webSocketClientId) {
                console.error('Received back my own message. Ignoring it');
                return;
            }

            chat.addMessage({role: 'peer', text: data.message});
        }
    )
}