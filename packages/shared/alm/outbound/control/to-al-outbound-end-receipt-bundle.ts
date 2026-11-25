import type { ALOutboundCommitBundle } from '../admission/al-outbound-admission-store.ts';
import {
    toALOutboundReadCommitFences,
    type ALOutboundMessageEndRead
} from '../message-end/to-al-outbound-message-end-bundle.ts';

/** The commit that ends one receipt: its pending-ACK row and its repair-attempt row, under the fences `read` saw. */
export function toALOutboundEndReceiptBundle<TPrepared>(
    senderId: string,
    msgId: string,
    read: Pick<ALOutboundMessageEndRead, 'storedMessage' | 'clientRecord' | 'messageVersion'>
): ALOutboundCommitBundle<TPrepared> {
    return {
        senderId,
        ...toALOutboundReadCommitFences({ originPeerId: senderId, msgId }, read),
        mutations: [
            { kind: 'delete-pending-ack', originPeerId: senderId, msgId },
            { kind: 'delete-repair-attempt', msgId }
        ],
        durableEffects: [],
        endedTimeoutEffectIds: []
    };
}
