import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { ClusterProofSocket } from '../cluster-proof-socket.mts';

/** Keeps every frame, publishes room messages, and acknowledges them as their receiver. */
export class OrderingProofSocket extends ClusterProofSocket {
    private constructor(socket: WebSocket) {
        super(socket, {
            failure: 'Ordering proof socket failed',
            frame: 'matching ordering frame',
            closeReason: 'ordering-proof-complete'
        });
    }

    static async open(input: ClusterProofSocket.OpenInput): Promise<OrderingProofSocket> {
        const observer = new OrderingProofSocket(await ClusterProofSocket.connect(input));
        await observer.waitForOpen();
        return observer;
    }

    /** The receiver's delivered ACK for one message, addressed back to its sender. */
    sendAck(message: ALMessage, recipientSessionId: string): void {
        this.send(newALAckControlMessage({
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: `ack-${message.id.msgId}-${recipientSessionId}`,
            senderId: recipientSessionId,
            ts: Date.now(),
            traceId: message.id.traceId
        }, {
            ackedMsgId: message.id.msgId,
            fromPeerId: recipientSessionId,
            toPeerId: message.id.senderId,
            originPeerId: message.id.senderId,
            logicalRecipientPeerId: recipientSessionId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now(),
            proof: null
        }));
    }

    receipts(): readonly ALReceiptPayload[] {
        return this.frames
            .filter((frame) => frame.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
            .map((frame) => decodeALReceiptPayload(JSON.parse(frame.payload.resource)));
    }
}
