import type { EdgeOrderStamp } from './edge-order-sender.ts';

/** Positions `from` to `to` of one stream that the receiver stopped waiting for. */
export interface EdgeOrderGap {
    readonly senderId: string;
    readonly stream: string;
    readonly from: number;
    readonly to: number;
}

/** The receiver's limits, its clock and timers, and where it hands messages and reports. */
export interface EdgeOrderReceiverInput<Message, Timer> {
    readonly maxHeldPerStream: number;
    readonly maxStreams: number;
    /** The entry window: how long a stream first seen past position 1 waits for earlier messages before it starts. */
    readonly entryWaitMs: number;
    now(): number;
    setTimer(run: () => void, delayMs: number): Timer;
    clearTimer(timer: Timer): void;
    handOver(message: Message): void;
    onGap(gap: EdgeOrderGap): void;
    onLate(senderId: string, stamp: EdgeOrderStamp): void;
}

interface HeldMessage<Message> {
    readonly n: number;
    readonly w: number;
    readonly expiresAtMs: number;
    readonly message: Message;
}

interface ReceivedStream<Message, Timer> {
    /** 0 while the stream is entering: nothing handed over yet and earlier sends may still arrive. */
    next: number;
    readonly enteredAtMs: number;
    lastSeenMs: number;
    timer: Timer | undefined;
    readonly held: Map<number, HeldMessage<Message>>;
}

/**
 * The receive side of edge order, as the measurement replays it: one sender's messages are handed over in the
 * sender's order; a missing one is waited for while its sender says it can still arrive, then skipped and reported;
 * a stream first seen past position 1 starts after a short entry window. The measurement's own receiver, not the
 * product's.
 */
export class EdgeOrderReceiver<Message, Timer> {
    private readonly streams = new Map<string, ReceivedStream<Message, Timer>>();
    private readonly input: EdgeOrderReceiverInput<Message, Timer>;

    constructor(input: EdgeOrderReceiverInput<Message, Timer>) {
        this.input = input;
    }

    accept(senderId: string, stamp: EdgeOrderStamp, expiresAtMs: number, message: Message): void {
        const now = this.input.now();
        const stream = this.readOrEnterStream(`${senderId}\n${stamp.s}`, stamp, now);
        stream.lastSeenMs = now;
        if (stream.next !== 0 && stamp.n < stream.next) {
            this.input.onLate(senderId, stamp);
            return;
        }
        if (stream.held.has(stamp.n)) {
            return;
        }
        stream.held.set(stamp.n, { n: stamp.n, w: stamp.w, expiresAtMs, message });
        if (stream.held.size > this.input.maxHeldPerStream) {
            this.skipToLowest(senderId, stamp.s, stream);
        }
        this.drain(senderId, stamp.s, stream);
    }

    getHeldCount(): number {
        let count = 0;
        for (const stream of this.streams.values()) {
            count += stream.held.size;
        }
        return count;
    }

    private readOrEnterStream(key: string, stamp: EdgeOrderStamp, now: number): ReceivedStream<Message, Timer> {
        const existing = this.streams.get(key);
        if (existing !== undefined) {
            return existing;
        }
        this.forgetIdleStreamAtCap();
        const entersAtOnce = stamp.n === 1 || stamp.w <= now;
        const stream: ReceivedStream<Message, Timer> = {
            next: entersAtOnce ? stamp.n : 0,
            enteredAtMs: now,
            lastSeenMs: now,
            timer: undefined,
            held: new Map()
        };
        this.streams.set(key, stream);
        return stream;
    }

    private drain(senderId: string, streamId: string, stream: ReceivedStream<Message, Timer>): void {
        if (stream.timer !== undefined) {
            this.input.clearTimer(stream.timer);
            stream.timer = undefined;
        }
        for (;;) {
            const head = stream.next === 0 ? undefined : stream.held.get(stream.next);
            if (head !== undefined) {
                stream.held.delete(head.n);
                stream.next = head.n + 1;
                this.input.handOver(head.message);
                continue;
            }
            if (stream.held.size === 0) {
                return;
            }
            const lowest = this.readLowestHeld(stream);
            const now = this.input.now();
            if (stream.next === 0 && (lowest.n === 1 || lowest.w <= now)) {
                stream.next = lowest.n;
                continue;
            }
            // The gap rule: wait while a missing earlier send can still arrive, never past the held message's own deadline.
            const waitUntil = Math.min(
                stream.next === 0 ? stream.enteredAtMs + this.input.entryWaitMs : lowest.w,
                lowest.expiresAtMs - 1
            );
            if (waitUntil > now) {
                stream.timer = this.input.setTimer(() => {
                    stream.timer = undefined;
                    this.drain(senderId, streamId, stream);
                }, waitUntil - now);
                return;
            }
            this.skipToLowest(senderId, streamId, stream);
        }
    }

    /** A stream that is still entering starts at its lowest held message with no gap report. */
    private skipToLowest(senderId: string, streamId: string, stream: ReceivedStream<Message, Timer>): void {
        const lowest = this.readLowestHeld(stream);
        if (stream.next !== 0 && lowest.n > stream.next) {
            this.input.onGap({ senderId, stream: streamId, from: stream.next, to: lowest.n - 1 });
        }
        stream.next = lowest.n;
    }

    private readLowestHeld(stream: ReceivedStream<Message, Timer>): HeldMessage<Message> {
        let lowest: HeldMessage<Message> | undefined;
        for (const held of stream.held.values()) {
            if (lowest === undefined || held.n < lowest.n) {
                lowest = held;
            }
        }
        if (lowest === undefined) {
            throw new Error('A stream that is drained holds a message');
        }
        return lowest;
    }

    private forgetIdleStreamAtCap(): void {
        if (this.streams.size < this.input.maxStreams) {
            return;
        }
        let idleKey: string | undefined;
        let idleSinceMs = Number.POSITIVE_INFINITY;
        for (const [key, stream] of this.streams) {
            if (stream.held.size === 0 && stream.lastSeenMs < idleSinceMs) {
                idleSinceMs = stream.lastSeenMs;
                idleKey = key;
            }
        }
        if (idleKey !== undefined) {
            this.streams.delete(idleKey);
        }
    }
}
