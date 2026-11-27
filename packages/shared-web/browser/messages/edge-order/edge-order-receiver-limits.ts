import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { AL_INBOUND_MAX_EVICTED_ORDERING_TRACKS } from '@shared/alm/inbound/admission/al-inbound-evicted-ordering-tracks.ts';
import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/admission/evict-al-inbound-ordering-tracks-past-cap.ts';

/** What a page keeps for edge order at most, whatever its channels declare. */
export interface EdgeOrderReceiverLimits {
    readonly maxHeldMessagesPerStream: number;
    readonly maxHeldBytesPerStream: number;
    readonly maxStreams: number;
    /**
     * The streams pushed out by `maxStreams` whose position is kept, so a late copy of a message one of them handed
     * over stays late. Past it the oldest record goes, and that stream enters as new when it is heard again.
     */
    readonly maxEvictedStreams: number;
}

export const EDGE_ORDER_RECEIVER_DEFAULT_LIMITS: EdgeOrderReceiverLimits = {
    maxHeldMessagesPerStream: AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages,
    maxHeldBytesPerStream: AL_MESSAGE_RESOURCE_LIMITS.bufferedBytes,
    maxStreams: AL_INBOUND_MAX_ORDERING_TRACKS,
    maxEvictedStreams: AL_INBOUND_MAX_EVICTED_ORDERING_TRACKS
};
