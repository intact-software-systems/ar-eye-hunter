import {ALPayload, toALMessage} from "@shared/al-contracts/al-contract.ts";
import {ChatScreen} from "../chat/chat-screen.ts";
import {addWebSocketInboxCallback, removeWebSocketInboxCallback} from "./ws-message-router.ts";
import {Middleware} from "./middleware.ts";
import {addRtcInboxCallback, removeRtcInboxCallback} from "./rtc-message-router.ts";

export function connectTransport(
    chat: ChatScreen,
    middleware: Middleware,
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
            const data = JSON.parse(payload.resource);
            console.log(`Received message: ` + JSON.stringify(data));

            if (data.message === undefined) {
                console.error('Invalid message received from server');
                return Promise.reject('Invalid message received from server');
            }
            if (data.clientId === clientId) {
                console.error('Received back my own message. Ignoring it');
                return Promise.resolve();
            }

            chat.addMessage({role: 'peer', text: data.message});

            return Promise.resolve();
        }
    )

    addRtcInboxCallback(
        typeId,
        (payload: ALPayload) => {
            const data = JSON.parse(payload.resource);
            console.log(`Received message: ` + JSON.stringify(data));

            if (data.message === undefined) {
                console.error('Invalid message received from server');
                return Promise.reject('Invalid message received from server');
            }
            if (data.clientId === clientId) {
                console.error('Received back my own message. Ignoring it');
                return Promise.resolve();
            }

            chat.addMessage({role: 'peer', text: data.message});

            return Promise.resolve();
        }
    )
}

export function disconnectTransport(typeId: string) {
    removeWebSocketInboxCallback(typeId)
    removeRtcInboxCallback(typeId)
}