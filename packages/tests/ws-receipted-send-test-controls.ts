import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_NACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALNackPayload, decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { WsServerInboundAuthorization } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';

import { toTestALAckPayload } from './al-control-test-payloads.ts';

/** A test socket's record of the frames a server wrote to it. */
export interface SentFramesSocket {
    readonly sent: readonly string[];
}

/** One control a server sent, as `nack:<reason>` or `receipt:<phase>`, under the msgId it answers. */
export interface ControlFrameLabel {
    readonly msgId: string;
    readonly control: string;
}

export interface WsDeliveredAckInput {
    readonly ackedMsgId: string;
    readonly fromPeerId: string;
    readonly originPeerId: string;
    readonly traceId: string;
}

/** One server-sent frame as `nack:<reason>` or `receipt:<phase>`, under the msgId it answers; any other frame by its typeId. */
export function toControlLabel(frame: ALMessage): ControlFrameLabel {
    if (frame.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID) {
        const receipt = decodeALReceiptPayload(JSON.parse(frame.payload.resource));
        return { msgId: receipt.msgId, control: `receipt:${receipt.phase}` };
    }
    if (frame.payload.typeId === AL_CONTROL_NACK_TYPE_ID) {
        const nack = decodeALNackPayload(JSON.parse(frame.payload.resource));
        return { msgId: nack.msgId, control: `nack:${nack.reason}` };
    }
    return { msgId: frame.id.msgId, control: frame.payload.typeId };
}

/** Every receipt a socket was sent, of any message, in send order. */
export function readSentReceipts(socket: SentFramesSocket): readonly ALReceiptPayload[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}

/** The `delivered` WS ACK a recipient sends its origin for a message it received over WS; each call is a new ACK. */
export function toWsDeliveredAckMessage(input: WsDeliveredAckInput): ALMessage {
    const nowMs = Date.now();
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${input.fromPeerId}-${crypto.randomUUID()}`, senderId: input.fromPeerId, ts: nowMs, traceId: input.traceId },
        toTestALAckPayload({
            ackedMsgId: input.ackedMsgId,
            fromPeerId: input.fromPeerId,
            toPeerId: input.originPeerId,
            originPeerId: input.originPeerId,
            logicalRecipientPeerId: input.fromPeerId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: nowMs
        })
    );
}

/** A room view behind the sender's: `not-yet-in-sync`, answered with its NACK, at the server's snapshot version. */
export function toNotYetInSyncRefusal(serverSnapshotVersion: number): WsServerInboundAuthorization {
    return {
        authorized: false,
        reason: 'not-yet-in-sync',
        logMessage: 'Room snapshot is catching up',
        sendNack: true,
        serverSnapshotVersion
    };
}
