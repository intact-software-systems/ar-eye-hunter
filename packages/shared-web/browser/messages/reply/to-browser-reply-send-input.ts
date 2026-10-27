import type {
    RallarMessageReplyOptions,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALReplyContextId } from '@shared/al-contracts/reply/to-al-reply-context-id.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';

/**
 * A unicast to the requester's session on the request's topic and in its room, on the `command` purpose's delivery
 * defaults. The context is `toALReplyContextId`, the server reply's rule; the requester matches on `replyToMsgId`,
 * never the route. A request that named no room is answered outside any room, never in the responder's default room.
 */
export function toBrowserReplySendInput<R>(
    request: ALMessage,
    payload: R,
    options: RallarMessageReplyOptions | undefined
): RallarWsSendInput<R> {
    const roomRef = readALTargetGroupRef(request);
    const defaults = AL_CHANNEL_SEND_DEFAULTS.command;
    return {
        peerId: request.id.senderId,
        scope: roomRef === undefined ? 'world' : 'room',
        roomRef,
        topicId: request.route.topicId,
        contextId: toALReplyContextId(request),
        typeId: options?.typeId ?? request.payload.typeId,
        payload,
        reliability: defaults.reliability,
        ack: defaults.ack,
        ttlMs: options?.ttlMs ?? defaults.ttlMs
    };
}
