import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { scheduleAtDeadline } from '@shared/resilience/timing/schedule-at-deadline.ts';

import { computeEdgeOrderStreamStep } from '@shared-web/browser/messages/edge-order/compute-edge-order-stream-step.ts';
import type { EdgeOrderGap } from '@shared-web/browser/messages/edge-order/edge-order-gap.ts';
import type {
    EdgeOrderHeldMessage,
    EdgeOrderReceivedStream
} from '@shared-web/browser/messages/edge-order/edge-order-received-stream.ts';
import type { EdgeOrderReceiverLimits } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';

export namespace EdgeOrderReceiver {
    export interface Arrival<Message> {
        readonly senderId: string;
        readonly stamp: EdgeOrderStamp;
        readonly expiresAtMs: number;
        readonly byteLength: number;
        readonly message: Message;
    }

    /** Both ports are called inside `accept` or a wake, one stream's messages in position order, and must not throw. */
    export interface Dependencies<Message> {
        readonly timers: Timers;
        handOver(message: Message): void;
        reportGap(gap: EdgeOrderGap): void;
    }

    export type Outcome = 'handed-over' | 'held' | 'late' | 'duplicate';

    export interface Counts {
        readonly streams: number;
        readonly heldMessages: number;
        readonly lateMessages: number;
        readonly duplicateMessages: number;
    }
}

/** The receive side of edge order: it hands each sender's stream over in the positions its sender stamped. */
export class EdgeOrderReceiver<Message> {
    /** Oldest first by last arrival: an arrival takes its stream out and puts it back as the newest. */
    private readonly streams = new LatestRepository<string, EdgeOrderReceivedStream<Message>>();
    private readonly limits: EdgeOrderReceiverLimits;
    private readonly dependencies: EdgeOrderReceiver.Dependencies<Message>;
    private heldMessages = 0;
    private lateMessages = 0;
    private duplicateMessages = 0;

    constructor(limits: EdgeOrderReceiverLimits, dependencies: EdgeOrderReceiver.Dependencies<Message>) {
        this.limits = limits;
        this.dependencies = dependencies;
    }

    accept(arrival: EdgeOrderReceiver.Arrival<Message>): EdgeOrderReceiver.Outcome {
        const nowMs = this.dependencies.timers.nowMs();
        const { stamp } = arrival;
        const stream = this.touchStream(arrival, nowMs);
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
        return stream.held.has(stamp.position) ? 'held' : 'handed-over';
    }

    getCounts(): EdgeOrderReceiver.Counts {
        return {
            streams: this.streams.size(),
            heldMessages: this.heldMessages,
            lateMessages: this.lateMessages,
            duplicateMessages: this.duplicateMessages
        };
    }

    private touchStream(
        arrival: EdgeOrderReceiver.Arrival<Message>,
        nowMs: number
    ): EdgeOrderReceivedStream<Message> {
        const key = JSON.stringify([arrival.senderId, arrival.stamp.streamId]);
        const stream = this.streams.take(key) ?? this.enterStream(arrival, nowMs);
        this.streams.acceptAt({ key, value: stream, nowEpochMs: nowMs });
        return stream;
    }

    private enterStream(arrival: EdgeOrderReceiver.Arrival<Message>, nowMs: number): EdgeOrderReceivedStream<Message> {
        this.forgetOldestStreamAtCap();
        return {
            senderId: arrival.senderId,
            streamId: arrival.stamp.streamId,
            firstSeenAtMs: nowMs,
            nextPosition: undefined,
            endedBelowPosition: 0,
            heldBytes: 0,
            forgotten: false,
            cancelWake: undefined,
            held: new Map()
        };
    }

    private forgetOldestStreamAtCap(): void {
        if (this.streams.size() < this.limits.maxStreams) {
            return;
        }
        const [oldestKey] = this.streams.keys();
        const oldest = this.streams.take(oldestKey);
        if (oldest !== undefined) {
            oldest.forgotten = true;
            this.release(oldest);
        }
    }

    private release(stream: EdgeOrderReceivedStream<Message>): void {
        let step = computeEdgeOrderStreamStep(stream, this.dependencies.timers.nowMs(), this.limits);
        while (step.kind !== 'rest' && step.kind !== 'wait') {
            if (step.kind === 'hand-over') {
                this.handOver(stream, step.held);
            }
            else {
                stream.nextPosition = step.nextPosition;
            }
            if (step.kind === 'skip') {
                this.dependencies.reportGap({
                    senderId: stream.senderId,
                    streamId: stream.streamId,
                    fromPosition: step.fromPosition,
                    toPosition: step.nextPosition - 1,
                    reason: step.reason
                });
            }
            step = computeEdgeOrderStreamStep(stream, this.dependencies.timers.nowMs(), this.limits);
        }

        stream.cancelWake?.();
        stream.cancelWake = step.kind === 'wait'
            ? scheduleAtDeadline(this.dependencies.timers, step.untilMs, () => this.release(stream))
            : undefined;
    }

    private handOver(stream: EdgeOrderReceivedStream<Message>, held: EdgeOrderHeldMessage<Message>): void {
        stream.held.delete(held.stamp.position);
        stream.heldBytes -= held.byteLength;
        stream.nextPosition = held.stamp.position + 1;
        this.heldMessages -= 1;
        this.dependencies.handOver(held.message);
    }
}
