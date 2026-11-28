import type { EdgeOrderReceiverLimits } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import { EdgeOrderReceiver } from '@shared-web/browser/messages/edge-order/edge-order-receiver.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import { EDGE_ORDER_DEFAULT_STREAM_WAITS } from '@shared-web/browser/messages/edge-order/edge-order-stream-waits.ts';
import type { RallarMessageOrderGap } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { createManualTimers } from '../../../../shared/resilience/manual-timers.ts';

/** One recipient's first read of a room message. Times are epoch milliseconds, with a fraction. */
export interface EdgeOrderArrival {
    readonly publisher: string;
    /** The stamp as it was read from the payload that arrived. */
    readonly stamp: EdgeOrderStamp;
    readonly arrivedAtMs: number;
    readonly expiresAtMs: number;
    /** The bytes of the payload that arrived, which the receiver counts against its held-byte cap. */
    readonly byteLength: number;
}

/** An arrival the receiver handed to the application, and when. */
export interface EdgeOrderHandOver {
    readonly arrival: EdgeOrderArrival;
    readonly handedOverAtMs: number;
}

/** What one recipient's application would have seen, had the receiver stood between the socket and it. */
export interface EdgeOrderReplay {
    /** In hand-over order. */
    readonly handOvers: readonly EdgeOrderHandOver[];
    readonly gaps: readonly RallarMessageOrderGap[];
    /** Arrivals dropped because the receiver had already passed their position. */
    readonly lateDrops: number;
    /** The most messages the receiver held at once, read after each arrival was accepted. */
    readonly mostHeld: number;
}

/** The one channel every measured room message travels on; with the publisher it names an arrival's stream. */
const MEASURED_CHANNEL = { topicId: 'room.notification', typeId: 'message.v1' };
/** The one room every measured stream is replayed in. */
const MEASURED_ROOM: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

/**
 * Runs one recipient's arrivals, in arrival order, through the browser's edge-order receiver on a clock that only
 * the arrivals and the receiver's own timers move, with the waits of a channel that declares none. The replay is
 * exact for the rule: the receiver reads no other clock.
 */
export async function replayEdgeOrderArrivals(
    arrivals: readonly EdgeOrderArrival[],
    limits: EdgeOrderReceiverLimits
): Promise<EdgeOrderReplay> {
    const timers = createManualTimers(0);
    const handOvers: EdgeOrderHandOver[] = [];
    const gaps: RallarMessageOrderGap[] = [];
    const receiver = new EdgeOrderReceiver<EdgeOrderArrival>(limits, {
        timers,
        handOver: (arrival) => {
            handOvers.push({ arrival, handedOverAtMs: timers.nowMs() });
        },
        reportGap: (gap) => {
            gaps.push(gap);
        }
    });
    let mostHeld = 0;
    for (const arrival of arrivals) {
        await timers.advanceTo(arrival.arrivedAtMs);
        receiver.accept({
            origin: { ...MEASURED_CHANNEL, senderId: arrival.publisher, roomRef: MEASURED_ROOM },
            stamp: arrival.stamp,
            waits: EDGE_ORDER_DEFAULT_STREAM_WAITS,
            expiresAtMs: arrival.expiresAtMs,
            byteLength: arrival.byteLength,
            message: arrival
        });
        mostHeld = Math.max(mostHeld, receiver.getCounts().heldMessages);
    }
    // No message is held past its own deadline, so the last deadline empties the receiver.
    await timers.advanceTo(Math.max(0, ...arrivals.map((arrival) => arrival.expiresAtMs)));
    return { handOvers, gaps, lateDrops: receiver.getCounts().lateMessages, mostHeld };
}
