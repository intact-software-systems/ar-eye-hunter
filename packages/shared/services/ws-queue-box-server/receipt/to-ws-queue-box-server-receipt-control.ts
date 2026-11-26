import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '../../../al-contracts/al-contract.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALReceiptControlMessage,
    type ALReceiptPayload
} from '../../../al-contracts/al-control.ts';
import { decodePersistedALMessageValue } from '../../../al-contracts/al-message-persistence-validation.ts';
import {
    toALReceiptRecordRefToken,
    type ALReceiptRecordRef
} from '../../../alm/receipt-record/al-receipt-record-keys.ts';
import type {
    ALReceiptRecordEndedHead,
    ALReceiptRecordOpening
} from '../../../alm/receipt-record/al-receipt-record-rows.ts';
import type { ALReceiptRecordTally } from '../../../alm/receipt-record/compute-al-receipt-record-tally.ts';
import { fnv1a64 } from '../../../queuebox/AppQueueIdentity.ts';

export type WsQueueBoxServerReceiptSets = Pick<
    ALReceiptRecordTally,
    'confirmedRecipientPeerIds' | 'outsideAudienceRecipientPeerIds'
>;

/** A receipt's sets at one phase, as observed at one instant. */
export interface WsQueueBoxServerReceiptState extends WsQueueBoxServerReceiptSets {
    readonly phase: ALReceiptPayload['phase'];
    readonly observedAtEpochMs: number;
}

/** A receipt the server writes to its outbox; only the ended work's terminal receipt settles the server's own row. */
export interface WsQueueBoxServerIssuedReceipt {
    readonly receipt: ALReceiptPayload;
    readonly opening: ALReceiptRecordOpening;
    readonly controlId: string;
    readonly settlesServerRow: boolean;
}

/** The control id of the terminal receipt the ended work of `ref` delivers, however often it delivers it. */
export function toWsQueueBoxServerEndedReceiptControlId(ref: ALReceiptRecordRef): string {
    return `al-receipt-ended:${fnv1a64(toALReceiptRecordRefToken(ref))}`;
}

/**
 * The terminal receipt the ended work delivers, the only receipt that settles the server's own row. The ended work
 * delivers at least once: one control id per receipt makes each repeat the outbox's duplicate.
 */
export function toWsQueueBoxServerEndedReceipt(ended: ALReceiptRecordEndedHead): WsQueueBoxServerIssuedReceipt {
    return {
        receipt: toWsQueueBoxServerReceiptPayload(ended.opening, { ...ended, observedAtEpochMs: ended.endedAtEpochMs }),
        opening: ended.opening,
        controlId: toWsQueueBoxServerEndedReceiptControlId(ended.opening),
        settlesServerRow: true
    };
}

/**
 * Whether this is an `admitted` receipt with a head behind it, which a re-sent copy is answered from. A sender that
 * resends nothing reads only its terminal receipt when this copy is lost on the wire. One that expects nobody has no
 * head and is the send's only answer.
 */
export function isWsQueueBoxServerHeadBackedAdmittedReceipt(receipt: ALReceiptPayload): boolean {
    return receipt.phase === 'admitted' && receipt.expectedRecipientPeerIds.length > 0;
}

/**
 * Whether the control's own codec carries the largest receipt this opening can need. That is a `timed-out` receipt
 * naming every expected recipient outside: a terminal receipt lists each recipient once across its two sets, both
 * keys are always written, one list costs one comma more than a split, and only `timed-out`, one character longer than
 * `complete`, can name every recipient without a confirmation. It is built by the same function as every receipt.
 */
export function isWsQueueBoxServerReceiptEncodable(opening: ALReceiptRecordOpening, serverPeerId: string): boolean {
    const largest: WsQueueBoxServerIssuedReceipt = {
        receipt: toWsQueueBoxServerReceiptPayload(opening, {
            confirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: opening.expectedRecipientPeerIds,
            phase: 'timed-out',
            observedAtEpochMs: opening.deadlineAtMs
        }),
        opening,
        controlId: toWsQueueBoxServerEndedReceiptControlId(opening),
        settlesServerRow: true
    };
    try {
        toWsQueueBoxServerReceiptControlMessage(largest, serverPeerId);
        return true;
    }
    catch (error) {
        // The receipt control's codec offers no typed refusal: it refuses by throwing `TypeError`, and only that.
        if (error instanceof TypeError) {
            return false;
        }
        throw error;
    }
}

/** The receipt control the server sends; it outlives the receipt's deadline by the receipt grace. */
export function toWsQueueBoxServerReceiptControlMessage(
    { receipt, opening, controlId }: WsQueueBoxServerIssuedReceipt,
    serverPeerId: string
): ALMessage {
    const id = {
        v: AL_MESSAGE_ENVELOPE_VERSION,
        msgId: controlId,
        senderId: serverPeerId,
        ts: receipt.observedAtEpochMs,
        traceId: opening.traceId
    };
    return decodePersistedALMessageValue({
        ...newALReceiptControlMessage(id, receipt),
        constraints: {
            expiresAtMs: Math.max(opening.deadlineAtMs, receipt.observedAtEpochMs) + AL_RECEIPT_DEADLINE_GRACE_MS
        }
    });
}

export function toWsQueueBoxServerReceiptPayload(
    opening: ALReceiptRecordOpening,
    state: WsQueueBoxServerReceiptState
): ALReceiptPayload {
    return {
        msgId: opening.msgId,
        originPeerId: opening.originPeerId,
        expectedRecipientPeerIds: opening.expectedRecipientPeerIds,
        confirmedRecipientPeerIds: state.confirmedRecipientPeerIds,
        outsideAudienceRecipientPeerIds: state.outsideAudienceRecipientPeerIds,
        snapshotVersion: opening.snapshotVersion,
        phase: state.phase,
        observedAtEpochMs: state.observedAtEpochMs
    };
}
