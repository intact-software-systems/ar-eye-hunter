import { readRallarMessageRoomId } from '@shared-web/browser/rallar-message-selectors.ts';
import type { RallarMessage, RallarMessageTransport } from '@shared-web/browser/rallar-messages-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

export function toRallarMessage<T>(
    transport: RallarMessageTransport,
    message: ALMessage
): RallarMessage<T> {
    return {
        transport,
        typeId: message.payload.typeId,
        topicId: message.route.topicId,
        contextId: message.route.contextId,
        resourceId: message.route.resourceId,
        roomId: readRallarMessageRoomId(message),
        senderId: message.id.senderId,
        payload: decodeMessagePayload<T>(message),
        raw: message,
        receivedAtEpochMs: Date.now()
    };
}

function decodeMessagePayload<T>(message: ALMessage): T {
    try {
        return JSON.parse(message.payload.resource) as T;
    }
    catch {
        return message.payload.resource as T;
    }
}
