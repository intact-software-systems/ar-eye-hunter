import type { ALOutboundCommitBundle } from '../admission/al-outbound-admission-store.ts';

/** The commit that ends one receipt: its pending-ACK row and its repair-attempt row, under the sender's fence. */
export function toALOutboundEndReceiptBundle<TPrepared>(
    senderId: string,
    msgId: string,
    expectedVersion: number | undefined
): ALOutboundCommitBundle<TPrepared> {
    return {
        senderId,
        expectedVersion,
        mutations: [
            { kind: 'delete-pending-ack', originPeerId: senderId, msgId },
            { kind: 'delete-repair-attempt', msgId }
        ],
        durableEffects: []
    };
}
