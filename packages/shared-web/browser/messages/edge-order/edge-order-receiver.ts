import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { scheduleAtDeadline } from '@shared/resilience/timing/schedule-at-deadline.ts';

import { computeEdgeOrderStreamStep } from '@shared-web/browser/messages/edge-order/compute-edge-order-stream-step.ts';
import {
    createEdgeOrderReceivedStream,
    toEdgeOrderStreamKey,
    type EdgeOrderHeldMessage,
    type EdgeOrderReceivedStream,
    type EdgeOrderStreamOrigin
} from '@shared-web/browser/messages/edge-order/edge-order-received-stream.ts';
import type { EdgeOrderReceiverLimits } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import type { RallarMessageOrderGap } from '@shared-web/browser/messages/rallar-message-contracts.ts';

export namespace EdgeOrderReceiver {
    export interface Arrival<Message> {
        /** The channel the message came on and its sender; with the stamp's stream they name the stream. */
        readonly origin: Omit<EdgeOrderStreamOrigin, 'stream'>;
        readonly stamp: EdgeOrderStamp;
        readonly expiresAtMs: number;
        readonly byteLength: number;
        readonly message: Message;
    }

    /** Both ports are called inside `accept` or a wake, one stream's messages in position order, and must not throw. */
    export interface Dependencies<Message> {
        readonly timers: Timers;
        handOver(message: Message): void;
        reportGap(gap: RallarMessageOrderGap): void;
    }

    /** `expired`: the arrival was already past its own deadline, so its position was given up, not handed over. */
    export type Outcome = 'handed-over' | 'held' | 'late' | 'duplicate' | 'expired';

    export interface Counts {
        readonly streams: number;
        readonly heldMessages: number;
        readonly lateMessages: number;
        readonly duplicateMessages: number;
        /** Messages that reached their turn past their own deadline: a release timer that fired late. */
        readonly expiredMessages: number;
        /** Held messages given up by `dropHeldMessages`. */
        readonly droppedMessages: number;
        /** The streams the stream cap pushed out whose position is still kept. */
        readonly evictedStreams: number;
    }
}

/** The receive side of edge order: it hands each sender's stream over in the positions its sender stamped. */
export class EdgeOrderReceiver<Message> {
    /** Oldest first by last arrival: an arrival takes its stream out and puts it back as the newest. */
    private readonly streams = new LatestRepository<string, EdgeOrderReceivedStream<Message>>();
    /**
     * The next position of each stream the stream cap pushed out, oldest eviction first. A stream that is heard
     * again takes its record back, so it goes on where it stood: a late copy stays late, and a message that is
     * missing is waited for as in any stream it follows.
     */
    private readonly evictedStreams: LatestRepository<string, number>;
    private readonly limits: EdgeOrderReceiverLimits;
    private readonly dependencies: EdgeOrderReceiver.Dependencies<Message>;
    private heldMessages = 0;
    private lateMessages = 0;
    private duplicateMessages = 0;
    private expiredMessages = 0;
    private droppedMessages = 0;

    constructor(limits: EdgeOrderReceiverLimits, dependencies: EdgeOrderReceiver.Dependencies<Message>) {
        this.limits = limits;
        this.dependencies = dependencies;
        this.evictedStreams = new LatestRepository({ maxEntries: limits.maxEvictedStreams });
    }

    accept(arrival: EdgeOrderReceiver.Arrival<Message>): EdgeOrderReceiver.Outcome {
        const nowMs = this.dependencies.timers.nowMs();
        const origin = { ...arrival.origin, stream: arrival.stamp.stream };
        const key = toEdgeOrderStreamKey(origin);
        const known = this.streams.take(key);
        const forgotten = known === undefined ? this.takeStreamToForget() : undefined;
        const stream = known ?? createEdgeOrderReceivedStream<Message>(origin, nowMs, this.evictedStreams.take(key));
        this.streams.acceptAt({ key, value: stream, nowEpochMs: nowMs });
        // The arrival's stream is in the table first: a hand-over can bring that stream's next arrival in the same turn.
        if (forgotten !== undefined) {
            forgotten.forgotten = true;
            this.release(forgotten);
            this.recordEvicted(forgotten);
        }
        return this.holdArrival(stream, arrival, nowMs);
    }

    /**
     * Gives up every held message and its timer, and keeps each stream's position: the clock the held messages
     * were judged by is gone, and a copy of a message already handed over must stay late.
     */
    dropHeldMessages(): number {
        const dropped = this.heldMessages;
        for (const key of this.streams.keys()) {
            const stream = this.streams.peek(key);
            if (stream !== undefined) {
                stream.cancelWake?.();
                stream.cancelWake = undefined;
                stream.held.clear();
                stream.heldBytes = 0;
            }
        }
        this.heldMessages = 0;
        this.droppedMessages += dropped;
        return dropped;
    }

    getCounts(): EdgeOrderReceiver.Counts {
        return {
            streams: this.streams.size(),
            heldMessages: this.heldMessages,
            lateMessages: this.lateMessages,
            duplicateMessages: this.duplicateMessages,
            expiredMessages: this.expiredMessages,
            droppedMessages: this.droppedMessages,
            evictedStreams: this.evictedStreams.size()
        };
    }

    private holdArrival(
        stream: EdgeOrderReceivedStream<Message>,
        arrival: EdgeOrderReceiver.Arrival<Message>,
        nowMs: number
    ): EdgeOrderReceiver.Outcome {
        const { stamp } = arrival;
        stream.endedBelowPosition = Math.max(stream.endedBelowPosition, stamp.lowestOpenPosition);
        if (stream.nextPosition !== undefined && stamp.position < stream.nextPosition) {
            this.lateMessages += 1;
            return 'late';
        }
        if (stream.held.has(stamp.position)) {
            this.duplicateMessages += 1;
            return 'duplicate';
        }

        stream.held.set(stamp.position, {
            stamp,
            expiresAtMs: arrival.expiresAtMs,
            byteLength: arrival.byteLength,
            heldSinceMs: nowMs,
            message: arrival.message
        });
        stream.heldBytes += arrival.byteLength;
        this.heldMessages += 1;
        this.release(stream);
        if (stream.held.has(stamp.position)) {
            return 'held';
        }
        return arrival.expiresAtMs <= nowMs ? 'expired' : 'handed-over';
    }

    /** At the stream cap: the least recently heard stream that holds nothing, or else the least recently heard. */
    private takeStreamToForget(): EdgeOrderReceivedStream<Message> | undefined {
        if (this.streams.size() < this.limits.maxStreams) {
            return undefined;
        }
        for (const key of this.streams.keys()) {
            if (this.streams.peek(key)?.held.size === 0) {
                return this.streams.take(key);
            }
        }
        const [leastRecentKey] = this.streams.keys();
        return this.streams.take(leastRecentKey);
    }

    /** A stream that had started keeps its position; one pushed out while still entering has none to keep. */
    private recordEvicted(stream: EdgeOrderReceivedStream<Message>): void {
        if (stream.nextPosition !== undefined) {
            this.evictedStreams.set(toEdgeOrderStreamKey(stream.origin), stream.nextPosition);
        }
    }

    private release(stream: EdgeOrderReceivedStream<Message>): void {
        let nowMs = this.dependencies.timers.nowMs();
        let step = computeEdgeOrderStreamStep(stream, nowMs, this.limits);
        while (step.kind !== 'rest' && step.kind !== 'wait') {
            if (step.kind === 'hand-over') {
                this.handOver(stream, step.held, nowMs);
            }
            else {
                stream.nextPosition = step.nextPosition;
            }
            if (step.kind === 'skip') {
                this.dependencies.reportGap({
                    ...stream.origin,
                    fromPosition: step.fromPosition,
                    toPosition: step.nextPosition - 1,
                    reason: step.reason
                });
            }
            nowMs = this.dependencies.timers.nowMs();
            step = computeEdgeOrderStreamStep(stream, nowMs, this.limits);
        }

        stream.cancelWake?.();
        stream.cancelWake = step.kind === 'wait'
            ? scheduleAtDeadline(this.dependencies.timers, step.untilMs, () => this.release(stream))
            : undefined;
    }

    /** A message whose turn comes past its own deadline is given up: a release timer can fire late. */
    private handOver(
        stream: EdgeOrderReceivedStream<Message>,
        held: EdgeOrderHeldMessage<Message>,
        nowMs: number
    ): void {
        const { position } = held.stamp;
        stream.held.delete(position);
        stream.heldBytes -= held.byteLength;
        stream.nextPosition = position + 1;
        this.heldMessages -= 1;
        if (held.expiresAtMs > nowMs) {
            this.dependencies.handOver(held.message);
            return;
        }
        this.expiredMessages += 1;
        this.dependencies.reportGap({
            ...stream.origin,
            fromPosition: position,
            toPosition: position,
            reason: 'held-message-expired'
        });
    }
}
