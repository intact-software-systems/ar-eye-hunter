import type {
    RallarMessageHandle,
    RallarMessagePayload,
    RallarMessageReplyOutcome
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { toALCorrId } from '@shared/al-contracts/reply/to-al-reply-actions.ts';

import type {
    BlackBoxRallarReplyWaitDiagnostics,
    BlackBoxRallarReplyWaitInput
} from '../black-box-rallar-operation-contracts.ts';

/** A timeout, an abort and an undelivered request are the wait's value, as a reply is; a handle never sent is not. */
export async function readBlackBoxRallarReplyWait(
    wait: BlackBoxRallarReplyWaitInput,
    handle: RallarMessageHandle | undefined
): Promise<BlackBoxRallarReplyWaitDiagnostics> {
    if (handle === undefined) {
        throw new TypeError(`messages.awaitReply names no retained handle ${wait.handleId}.`);
    }
    const outcome = await handle.awaitReply<RallarMessagePayload>({ timeoutMs: wait.timeoutMs });
    return toBlackBoxRallarReplyWaitDiagnostics(wait.handleId, handle.corrId, outcome);
}

/** A reply always names its request: `reply()` mints the field and the registry matches a reply on it. */
export function requireBlackBoxRallarReplyToMsgId(msgId: string, replyToMsgId: string | undefined): string {
    if (replyToMsgId === undefined) {
        throw new Error(`Message ${msgId} names no replyToMsgId, so it is no reply.`);
    }
    return replyToMsgId;
}

function toBlackBoxRallarReplyWaitDiagnostics(
    handleId: string,
    corrId: string,
    outcome: RallarMessageReplyOutcome<RallarMessagePayload>
): BlackBoxRallarReplyWaitDiagnostics {
    const state = outcome.lifecycle.state;
    if (outcome.status !== 'replied') {
        return { handleId, status: outcome.status, state, corrId };
    }
    const { reply } = outcome;
    return {
        handleId,
        status: outcome.status,
        state,
        corrId,
        reply: {
            msgId: reply.raw.id.msgId,
            replyToMsgId: requireBlackBoxRallarReplyToMsgId(reply.raw.id.msgId, reply.raw.actions?.replyToMsgId),
            corrId: toALCorrId(reply.raw),
            senderId: reply.senderId,
            typeId: reply.typeId,
            traceId: reply.traceId
        }
    };
}
