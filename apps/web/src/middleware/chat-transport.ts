import {ALPayload, toALMessage} from "@shared/al-contracts/al-contract.ts";
import {ClientData} from "@shared/api/api-config.ts";
import {ChatScreen} from "../chat/chat-screen.ts";
import {addWebSocketInboxCallback, removeWebSocketInboxCallback} from "./ws-message-router.ts";
import {Middleware} from "./middleware.ts";
import {addRtcInboxCallback, removeRtcInboxCallback} from "./rtc-message-router.ts";

type ChatMessage = {
    sessionId: string,
    message: string
}

export function connectTransport(
    chat: ChatScreen,
    middleware: Middleware,
    typeId: string,
    clientData: ClientData
) {
    chat.configure({
        onSend: async (text) => {

            const message =
                toALMessage<ChatMessage>(
                    clientData.sessionId,
                    typeId,
                    {
                        sessionId: clientData.sessionId,
                        message: text
                    }
                );

            console.log(`Sending message: ` + JSON.stringify(message));

            // await middleware.webSocketQueueBox.enqueueOutboxIfAbsent(message)
            await middleware.webRtcQueueBox.enqueueOutboxIfAbsent(message)
        },
        onReady: (api) => {
            api.addMessage({role: 'peer', text: 'Connected.'});
        }
    });

    addWebSocketInboxCallback(
        typeId,
        (payload: ALPayload) => {
            const data = JSON.parse(payload.resource) as ChatMessage;
            console.log(`Received message: ` + JSON.stringify(data));

            if (data.message === undefined) {
                console.error('Invalid message received from server');
                return Promise.reject('Invalid message received from server');
            }
            if (data.sessionId === clientData.sessionId) {
                console.error('Received back my own message. Ignoring it');
                return Promise.resolve();
            }

            chat.addPeerMessage(data.sessionId, data.message);

            return Promise.resolve();
        }
    )

    addRtcInboxCallback(
        typeId,
        (payload: ALPayload) => {
            const data = JSON.parse(payload.resource) as ChatMessage;
            console.log(`Received message: ` + JSON.stringify(data));

            if (data.message === undefined) {
                console.error('Invalid message received from server');
                return Promise.reject('Invalid message received from server');
            }
            if (data.sessionId === clientData.sessionId) {
                console.error('Received back my own message. Ignoring it');
                return Promise.resolve();
            }

            chat.addPeerMessage(data.sessionId, data.message);

            return Promise.resolve();
        }
    )
}

export function disconnectTransport(typeId: string) {
    removeWebSocketInboxCallback(typeId)
    removeRtcInboxCallback(typeId)
}