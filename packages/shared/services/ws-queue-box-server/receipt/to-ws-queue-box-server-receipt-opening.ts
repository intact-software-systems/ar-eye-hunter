import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALReceiptRecordOpening } from '../../../alm/receipt-record/al-receipt-record-rows.ts';
import { AL_RECEIPT_RECORD_WINDOW_MS } from '../../../alm/receipt-record/validate-al-receipt-record-opening.ts';
import type { WsServerRoomAudience } from '../ws-queue-box-server-contracts.ts';

/** The receipt a message asks the server for: its own deadline, else the ACK timeout its policy resolves to. */
export interface WsQueueBoxServerReceiptTerms {
    readonly ownDeadlineAtMs: number | undefined;
    readonly ackTimeoutMs: number;
}

/** A head opened from one admitted message, for the audience it answers for. */
export interface WsQueueBoxServerReceiptOpeningInput {
    readonly message: ALMessage;
    readonly originPeerId: string;
    readonly neverSentRecipientPeerIds: readonly string[];
    readonly roomAudience: WsServerRoomAudience;
    readonly terms: WsQueueBoxServerReceiptTerms;
    readonly nowMs: number;
}

export interface WsQueueBoxServerCopyReceiptOpeningInput extends WsQueueBoxServerReceiptOpeningInput {
    /** The audience the copy's admission row holds; undefined when no admission of it committed. */
    readonly ingressAudience: readonly string[] | undefined;
}

/**
 * The head a first admission opens: the message's own deadline, else its ACK timeout from now, and never beyond the
 * record's window, whatever deadline the client named.
 */
export function toWsQueueBoxServerReceiptOpening(
    { message, originPeerId, neverSentRecipientPeerIds, roomAudience, terms, nowMs }:
        WsQueueBoxServerReceiptOpeningInput
): ALReceiptRecordOpening {
    return {
        msgId: message.id.msgId,
        originPeerId,
        traceId: message.id.traceId,
        expectedRecipientPeerIds: toWsQueueBoxServerFrozenAudience(
            message,
            originPeerId,
            roomAudience.recipientPeerIds
        ),
        neverSentRecipientPeerIds,
        snapshotVersion: roomAudience.snapshotVersion,
        deadlineAtMs: Math.min(terms.ownDeadlineAtMs ?? nowMs + terms.ackTimeoutMs, nowMs + AL_RECEIPT_RECORD_WINDOW_MS)
    };
}

/**
 * The head a re-sent copy opens for an admission that committed and never opened one: the audience its admission row
 * holds, and the message's own deadline. A message that names no deadline, names one beyond the window, or is as old
 * as the window by its own stamp opens nothing, since its first head may have ended and expired; so does a row that
 * freezes to nobody.
 */
export function toWsQueueBoxServerCopyReceiptOpening(
    input: WsQueueBoxServerCopyReceiptOpeningInput
): ALReceiptRecordOpening | undefined {
    const { message, roomAudience, ingressAudience, terms, nowMs } = input;
    const { ownDeadlineAtMs } = terms;
    if (
        ingressAudience === undefined || ownDeadlineAtMs === undefined ||
        ownDeadlineAtMs > nowMs + AL_RECEIPT_RECORD_WINDOW_MS ||
        nowMs - message.id.ts >= AL_RECEIPT_RECORD_WINDOW_MS
    ) {
        return undefined;
    }
    const opening = toWsQueueBoxServerReceiptOpening({
        ...input,
        neverSentRecipientPeerIds: [],
        roomAudience: { recipientPeerIds: ingressAudience, snapshotVersion: roomAudience.snapshotVersion }
    });
    return opening.expectedRecipientPeerIds.length === 0 ? undefined : opening;
}

/**
 * The unicast addressee alone when the room admitted it (D53); a room send's authorized sessions but its origin.
 * A multicast the origin froze (an RTC leg handed to WS) keeps that audience verbatim, so a session that left since
 * reads unconfirmed (Q12); delivery stays the authorized sessions, so the expected set may exceed the delivered set by
 * design.
 */
export function toWsQueueBoxServerFrozenAudience(
    message: ALMessage,
    originPeerId: string,
    authorizedPeerIds: readonly string[]
): readonly string[] {
    const targets = message.targets;
    if (targets?.mode === 'unicast') {
        return targets.toPeerId !== originPeerId && authorizedPeerIds.includes(targets.toPeerId)
            ? [targets.toPeerId]
            : [];
    }
    const frozen = resolveALFrozenMulticastAudience(targets);
    if (frozen !== undefined) {
        return frozen.recipientPeerIds.filter((peerId) => peerId !== originPeerId);
    }
    return [...new Set(authorizedPeerIds)].filter((peerId) =>
        peerId !== originPeerId &&
        (targets?.mode !== 'broadcast' ||
            (!targets.exceptPeerIds?.includes(peerId) &&
                (targets.recipientPeerIds === undefined ||
                    targets.recipientPeerIds.includes(peerId))))
    );
}
