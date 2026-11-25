import type { ALOutboundAdmissionStore, ALOutboundCommitBundle } from '../admission/al-outbound-admission-store.ts';
import { toALOutboundEndReceiptBundle } from '../control/to-al-outbound-end-receipt-bundle.ts';
import type { ALOutboundEndedReason } from '../lane/al-outbound-send-controls.ts';
import { toALOutboundMessageEndBundle, type ALOutboundMessageEndRead } from './to-al-outbound-message-end-bundle.ts';

/**
 * What ending a message wrote: the stored row was marked ended, there was no row to mark (none in this store, one
 * already ended, or one whose retention ran out under the commit), or the sender's fence moved under the commit,
 * which names the message's deadline for the end retained as work.
 */
export type ALOutboundMessageEndOutcome =
    | Readonly<{ kind: 'ended' | 'nothing-to-end'; }>
    | Readonly<{ kind: 'conflict'; expiresAtMs: number; }>;

/**
 * Ends one message in a commit of its own with the bundle every terminal settlement commits, and states nothing:
 * the caller already stated the cancel, and a hand-over states none. A row already ended is not marked again: a cancel
 * of it writes nothing, a hand-over deletes only its receipt row.
 */
export async function writeALOutboundMessageEnd<TPrepared>(
    admissionStore: ALOutboundAdmissionStore<TPrepared>,
    msgId: string,
    endedReason: ALOutboundEndedReason
): Promise<ALOutboundMessageEndOutcome> {
    const read = await admissionStore.readMessageEnd(msgId);
    const stored = read.storedMessage;
    const bundle = toEndedReasonBundle<TPrepared>(msgId, endedReason, read);
    if (stored === undefined || bundle === undefined) {
        return { kind: 'nothing-to-end' };
    }
    const status = await admissionStore.commitBundle(bundle);
    if (status === 'conflict') {
        return { kind: 'conflict', expiresAtMs: stored.reference.expiresAtMs };
    }
    return { kind: status === 'committed' ? 'ended' : 'nothing-to-end' };
}

/**
 * A cancel keeps the receipt row as every end does. A hand-over deletes it: the carrier the message moves to owns its
 * receipt now. It does so even on a row an earlier end marked, as when a message whose RTC receipt was exhausted is
 * handed to WS.
 */
function toEndedReasonBundle<TPrepared>(
    msgId: string,
    endedReason: ALOutboundEndedReason,
    read: ALOutboundMessageEndRead
): ALOutboundCommitBundle<TPrepared> | undefined {
    const stored = read.storedMessage;
    if (stored === undefined) {
        return undefined;
    }
    const senderId = stored.reference.senderId;
    const deletesReceipt = endedReason === 'handed-over' && read.pendingAck !== undefined;
    if (stored.ended) {
        return deletesReceipt ? toALOutboundEndReceiptBundle(senderId, msgId, read) : undefined;
    }
    const end = toALOutboundMessageEndBundle<TPrepared>({
        senderId,
        msgId,
        stored,
        expectedVersion: read.clientRecord?.version,
        messageVersion: read.messageVersion,
        openReceipt: read.pendingAck,
        firstHopWait: read.firstHopWait
    });
    return deletesReceipt
        ? { ...end, mutations: [...end.mutations, { kind: 'delete-pending-ack', originPeerId: senderId, msgId }] }
        : end;
}
