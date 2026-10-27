import { newALEventRoute, newALUnicastMessage, readALTargetGroupRef, type ALMessage } from '../al-contract.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '../resolve-al-channel-send-defaults.ts';
import { toALReplyActions } from './to-al-reply-actions.ts';

export interface ALReplyMessageInput<T> {
    readonly senderId: string;
    readonly typeId: string;
    readonly payload: T;
}

export function newALReplyMessage<T>(request: ALMessage, input: ALReplyMessageInput<T>): ALMessage {
    return newALUnicastMessage(
        input.senderId,
        newALEventRoute(request.route.topicId, request.route.contextId),
        request.id.senderId,
        input.typeId,
        input.payload,
        {
            groupRef: readALTargetGroupRef(request),
            reliability: AL_CHANNEL_SEND_DEFAULTS.command.reliability,
            ack: AL_CHANNEL_SEND_DEFAULTS.command.ack,
            ttlMs: AL_CHANNEL_SEND_DEFAULTS.command.ttlMs,
            actions: toALReplyActions(request)
        }
    );
}
