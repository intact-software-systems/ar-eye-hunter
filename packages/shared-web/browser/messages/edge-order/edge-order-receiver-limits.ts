import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/admission/evict-al-inbound-ordering-tracks-past-cap.ts';

export interface EdgeOrderReceiverLimits {
    readonly maxHeldMessagesPerStream: number;
    readonly maxHeldBytesPerStream: number;
    readonly maxStreams: number;
    /** How long a stream first seen past its start waits for earlier messages before it starts. */
    readonly entryWaitMs: number;
    /** The longest a channel lets a message be held for order; absent when only the sender's statement bounds it. */
    readonly gapWaitCapMs: number | undefined;
}

export const EDGE_ORDER_RECEIVER_DEFAULT_LIMITS: EdgeOrderReceiverLimits = {
    maxHeldMessagesPerStream: AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages,
    maxHeldBytesPerStream: AL_MESSAGE_RESOURCE_LIMITS.bufferedBytes,
    maxStreams: AL_INBOUND_MAX_ORDERING_TRACKS,
    entryWaitMs: 500,
    gapWaitCapMs: undefined
};
