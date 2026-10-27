import type {
    RallarMessage,
    RallarMessageHandle,
    RallarMessageReplyOptions,
    RallarMessageTransport,
    RallarStateEventMessage
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { readRallarMessageRoomId } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

/** The one place a received message's `reply()` sends from: the messaging sender's reply path. */
export type RallarMessageReplySender = <R>(
    request: ALMessage,
    payload: R,
    options: RallarMessageReplyOptions | undefined
) => Promise<RallarMessageHandle>;

export function toRallarMessage<T>(
    transport: RallarMessageTransport,
    message: ALMessage,
    sendReply: RallarMessageReplySender
): RallarMessage<T> {
    return {
        ...toRallarStateEventMessage<T>(transport, message),
        reply: async (payload, options) => await sendReply(message, payload, options)
    };
}

export function toRallarStateEventMessage<T>(
    transport: RallarMessageTransport,
    message: ALMessage
): RallarStateEventMessage<T> {
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
