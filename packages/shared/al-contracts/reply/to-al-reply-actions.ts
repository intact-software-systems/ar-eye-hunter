import type { ALActions, ALMessage } from '../al-contract.ts';

/** A message without `actions.corrId` starts its own correlation: the correlation id is its msgId. */
export function toALCorrId(message: ALMessage): string {
    return message.actions?.corrId ?? message.id.msgId;
}

export function toALReplyActions(request: ALMessage): Required<ALActions> {
    return {
        corrId: toALCorrId(request),
        replyToMsgId: request.id.msgId
    };
}
