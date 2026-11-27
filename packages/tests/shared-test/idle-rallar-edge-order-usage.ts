import type { RallarEdgeOrderUsage } from '@shared-web/browser/messages/rallar-message-operations.ts';

/** The edge-order block of a page that has neither sent nor received on an edge-ordered channel. */
export const IDLE_RALLAR_EDGE_ORDER_USAGE: RallarEdgeOrderUsage = {
    streams: 0,
    heldMessages: 0,
    evictedStreams: 0,
    lateDrops: 0,
    gaps: 0,
    heldDropped: 0,
    sendStreams: 0,
    openSends: 0
};
