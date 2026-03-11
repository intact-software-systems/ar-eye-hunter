import { ALPayload } from '@shared/al-contracts/al-contract.ts';
import { ClientInfo } from '@shared/api/api-config.ts';
import { ChatScreen } from './chat-screen.ts';
import { removeWebSocketInboxCallback } from '@shared-web/browser/ws-message-router.ts';
import { Middleware } from '@shared-web/browser/middleware.ts';
import { addRtcInboxCallback, removeRtcInboxCallback, } from '@shared-web/browser/rtc-message-router.ts';
import { ChatTextPayload, newALChatTextMulticastMessage } from './al-chat-messages.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export function connectTransport(
    chat: ChatScreen,
    middleware: Middleware,
    typeId: string,
    clientData: ClientInfo,
) {
    chat.configure({
        onSend: async (text) => {
            const groupId = groupStateSnapshotsRepository
                .findFirstGroupStateSnapshotIdSessionIdIsIn(clientData.sessionId);
            if (groupId === undefined) {
                console.error(`Could not find group for session ${clientData.sessionId}`);
                return;
            }

            const msg = newALChatTextMulticastMessage(
                clientData.sessionId,
                groupId,
                text,
            );

            console.log(`Sending message: ` + JSON.stringify(msg));

            await middleware.rtcRxStreamer.enqueueOutboxIfAbsent(msg);
        },
        onReady: (api) => {
            api.addMessage(
                {
                    role: clientData.sessionId,
                    text: 'Connected',
                },
            );
        },
    });

    addRtcInboxCallback(
        typeId,
        (payload: ALPayload) => {
            const data = JSON.parse(payload.resource) as ChatTextPayload;
            console.log(`Received message: ` + JSON.stringify(data));

            if (data.text === undefined) {
                console.error('Invalid message received from server');
                return Promise.reject('Invalid message received from server');
            }
            if (data.senderId === clientData.sessionId) {
                console.error('Received back my own message. Ignoring it');
                return Promise.resolve();
            }

            chat.addPeerMessage(data.senderId, data.text);

            return Promise.resolve();
        },
    );
}

export function disconnectTransport(typeId: string) {
    removeWebSocketInboxCallback(typeId);
    removeRtcInboxCallback(typeId);
}
