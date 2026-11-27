import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';

export interface ToOrderedSendAckInput {
    /** The copy the recipient's socket read. */
    readonly copy: ALMessage;
    readonly recipientPeerId: string;
    readonly observedAtEpochMs: number;
}

/** The receiver ACK a browser sends its server for a copy it read on the WS carrier: delivered, to the copy's sender. */
export function toOrderedSendAck(input: ToOrderedSendAckInput): ALMessage {
    const { copy, recipientPeerId, observedAtEpochMs } = input;
    return newALAckControlMessage(
        {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: `${recipientPeerId}-ack-${copy.id.msgId}`,
            senderId: recipientPeerId,
            ts: observedAtEpochMs,
            traceId: copy.id.traceId
        },
        {
            ackedMsgId: copy.id.msgId,
            fromPeerId: recipientPeerId,
            toPeerId: copy.id.senderId,
            originPeerId: copy.id.senderId,
            logicalRecipientPeerId: recipientPeerId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs,
            proof: null
        }
    );
}
