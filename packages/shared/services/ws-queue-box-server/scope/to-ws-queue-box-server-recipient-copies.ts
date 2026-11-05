import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { WsServerResolvedRecipient } from '../ws-queue-box-server-contracts.ts';
import { toWsQueueBoxServerRecipientCopy } from './to-ws-queue-box-server-recipient-copy.ts';

export interface WsQueueBoxServerRecipientCopies {
    /** Each recipient the send reaches, with the copy it receives. */
    readonly copies: readonly Readonly<{ recipient: WsServerResolvedRecipient; message: ALMessage; }>[];
    /** The recipients a later row of the track already reached: the send reaches none of them. */
    readonly belowPositionPeerIds: readonly string[];
}

/** One live send's copies, each through the one per-recipient copy (`toWsQueueBoxServerRecipientCopy`). */
export function toWsQueueBoxServerRecipientCopies(
    message: ALMessage,
    recipients: readonly WsServerResolvedRecipient[],
    sentPositions: Readonly<Record<string, number>> | null
): WsQueueBoxServerRecipientCopies {
    const copies: { recipient: WsServerResolvedRecipient; message: ALMessage; }[] = [];
    const belowPositionPeerIds: string[] = [];
    for (const recipient of recipients) {
        const copy = toWsQueueBoxServerRecipientCopy({ message, recipientPeerId: recipient.peerId, sentPositions });
        if (copy.right === undefined) {
            belowPositionPeerIds.push(recipient.peerId);
        }
        else {
            copies.push({ recipient, message: copy.right });
        }
    }
    return { copies, belowPositionPeerIds };
}
