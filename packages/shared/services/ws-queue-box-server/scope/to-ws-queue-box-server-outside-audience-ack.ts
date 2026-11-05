import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '../../../al-contracts/al-contract.ts';
import { newALAckControlMessage } from '../../../al-contracts/al-control.ts';

export interface ToWsQueueBoxServerOutsideAudienceAckInput {
    /** The row the server sent the recipient nothing of. */
    readonly message: ALMessage;
    readonly recipientPeerId: string;
    readonly serverPeerId: string;
    readonly controlId: string;
    readonly nowMs: number;
}

/**
 * The server's word that it sent one recipient of its origin's row nothing -- a session the re-check dropped (D498)
 * or one already past the row's sequence -- in the vocabulary a recipient that delivered nothing ends its hop with,
 * so the receipt records the recipient outside the audience and never confirmed (S4-R9).
 */
export function toWsQueueBoxServerOutsideAudienceAck(input: ToWsQueueBoxServerOutsideAudienceAckInput): ALMessage {
    const { message, serverPeerId, nowMs } = input;
    const originPeerId = message.id.senderId;
    return newALAckControlMessage(
        {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: input.controlId,
            senderId: serverPeerId,
            ts: nowMs,
            traceId: message.id.traceId
        },
        {
            ackedMsgId: message.id.msgId,
            fromPeerId: serverPeerId,
            toPeerId: originPeerId,
            originPeerId,
            logicalRecipientPeerId: input.recipientPeerId,
            carrier: 'ws',
            status: 'subtree-complete-not-subscribed',
            observedAtEpochMs: nowMs
        }
    );
}
