import type { ALActions, ALMessage } from './al-contract.ts';

/** A message without `actions.corrId` starts its own correlation: the correlation id is its msgId. */
export function toALCorrId(message: ALMessage): string {
    return message.actions?.corrId ?? message.id.msgId;
}

export function isALReplyMessage(message: ALMessage): boolean {
    return message.actions?.replyToMsgId !== undefined;
}

/** The one place reply fields are minted, so the browser and the server reply the same way. */
export function toALReplyActions(request: ALMessage): Required<ALActions> {
    return {
        corrId: toALCorrId(request),
        replyToMsgId: request.id.msgId
    };
}
