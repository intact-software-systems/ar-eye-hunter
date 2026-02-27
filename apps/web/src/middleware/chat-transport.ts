import {ChatScreen} from "../chat/chat-screen.ts";
import {ALPayload, toALMessage} from "@shared/al-contracts/al-contract.ts";
import {webSocketQueueBox} from "./ws-engine.ts";
import {addWebSocketInboxCallback} from "./ws-message-router.ts";

export function initialiseChatTransport(
    chat: ChatScreen,
    typeId: string,
    clientId: string
) {
    chat.configure({
        onSend: async (text) => {

            const message =
                toALMessage(
                    clientId,
                    typeId,
                    {
                        clientId: clientId,
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
            if (data.clientId === clientId) {
                console.error('Received back my own message. Ignoring it');
                return;
            }

            chat.addMessage({role: 'peer', text: data.message});
        }
    )
}