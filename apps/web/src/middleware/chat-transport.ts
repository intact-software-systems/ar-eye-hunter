import {ALPayload, toALMessage} from "@shared/al-contracts/al-contract.ts";
import {ClientData} from "@shared/api/api-config.ts";
import {ChatMessage, ChatScreen} from "../chat/chat-screen.ts";
import {removeWebSocketInboxCallback} from "./ws-message-router.ts";
import {Middleware} from "./middleware.ts";
import {addRtcInboxCallback, removeRtcInboxCallback} from "./rtc-message-router.ts";
import {cachedChatMessageById} from "./data-caches.ts";

type ChatMessageDto = {
    sessionId: string,
    message: ChatMessage
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
                toALMessage<ChatMessageDto>(
                    clientData.sessionId,
                    typeId,
                    {
                        sessionId: clientData.sessionId,
                        message: {
                            id: crypto.randomUUID().toString(),
                            role: clientData.sessionId,
                            text: text,
                            createdAt: Date.now()
                        }
                    }
                );

            console.log(`Sending message: ` + JSON.stringify(message));

            await middleware.webRtcQueueBox.enqueueOutboxIfAbsent(message)
        },
        onReady: (api) => {

            if (cachedChatMessageById.size > 0) {
                api.clearMessages()
            }

            cachedChatMessageById
                .forEach(message => {
                        api.addMessage(
                            {
                                role: message.role,
                                text: message.text
                            }
                        )
                    }
                )
        }
    });

    addRtcInboxCallback(
        typeId,
        (payload: ALPayload) => {
            const data = JSON.parse(payload.resource) as ChatMessageDto;
            console.log(`Received message: ` + JSON.stringify(data));

            if (data.message === undefined) {
                console.error('Invalid message received from server');
                return Promise.reject('Invalid message received from server');
            }
            if (data.sessionId === clientData.sessionId) {
                console.error('Received back my own message. Ignoring it');
                return Promise.resolve();
            }

            chat.addPeerMessage(data.message.id, data.message.text);

            return Promise.resolve();
        }
    )
}

export function disconnectTransport(typeId: string) {
    removeWebSocketInboxCallback(typeId)
    removeRtcInboxCallback(typeId)
}