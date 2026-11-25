import type { ALAckPayload } from '../../../al-contracts/al-control.ts';
import { isALOwnWord } from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { isALRecipientConfirmationAck } from '../../../alm/delivery/is-al-recipient-confirmation-ack.ts';
import type { ALReceiptRecord } from '../../../alm/receipt-record/al-receipt-record.ts';
import type { ALReceiptRecordConfirmationDto } from '../../../alm/receipt-record/validate-al-receipt-record-confirmation.ts';
import type { Either } from '../../../resilience/Either.ts';
import type { WsQueueBoxServerReceiptObservation } from '../ws-queue-box-server-receipt-observation.ts';

/** What one count read: its outcome, and the view a counted ACK returned. */
export interface WsQueueBoxServerCountedAck {
    readonly outcome: Extract<WsQueueBoxServerReceiptObservation, { readonly kind: 'ack-count'; }>['outcome'];
    readonly view: ALReceiptRecord.View | undefined;
}

export const WS_QUEUE_BOX_SERVER_REJECTED_COUNT: WsQueueBoxServerCountedAck = { outcome: 'rejected', view: undefined };

/**
 * The record counts an ACK addressed to the origin it names that is its recipient's own word, or the server's own
 * `not-sent`; it counts no other.
 */
export function isWsQueueBoxServerCountableAck(ack: ALAckPayload, serverPeerId: string): boolean {
    return ack.toPeerId === ack.originPeerId && (isALOwnWord(ack) || isWsQueueBoxServerNotSentAck(ack, serverPeerId));
}

/**
 * The server speaks for a recipient only to say it sent that recipient nothing, which confirms nobody. It states
 * `not-sent` only from its own path; a frame a session sent never carries the server's peer id as its sender, so no
 * recipient's own word becomes it.
 */
export function isWsQueueBoxServerNotSentAck(ack: ALAckPayload, serverPeerId: string): boolean {
    return ack.fromPeerId === serverPeerId && !isALRecipientConfirmationAck(ack);
}

/** The record's confirmation an ACK states: the server's `not-sent`, a recipient's confirmation, or its outside. */
export function toWsQueueBoxServerAckConfirmation(
    ack: ALAckPayload,
    serverPeerId: string
): ALReceiptRecordConfirmationDto {
    const kind = isWsQueueBoxServerNotSentAck(ack, serverPeerId)
        ? 'not-sent'
        : isALRecipientConfirmationAck(ack)
        ? 'confirmed'
        : 'outside';
    return {
        originPeerId: ack.originPeerId,
        msgId: ack.ackedMsgId,
        recipientPeerId: ack.logicalRecipientPeerId,
        kind
    };
}

/** A count's answer as its `ack-count` observation states it: only a view still open and complete is `complete`. */
export function toWsQueueBoxServerCountedAck(
    counted: Either<
        ALReceiptRecord.HeadAbsent | ALReceiptRecord.InvalidConfirmation | ALReceiptRecord.Conflict,
        ALReceiptRecord.CountedAhead
    >
): WsQueueBoxServerCountedAck {
    return counted.fold<WsQueueBoxServerCountedAck>(
        (refusal) =>
            refusal.kind === 'conflict' ? { outcome: 'conflict', view: undefined } : WS_QUEUE_BOX_SERVER_REJECTED_COUNT,
        (written) => {
            if (!('view' in written)) {
                return { outcome: 'partial', view: undefined };
            }
            const { head, tally } = written.view;
            return { outcome: head.phase === 'open' && tally.complete ? 'complete' : 'partial', view: written.view };
        }
    );
}
