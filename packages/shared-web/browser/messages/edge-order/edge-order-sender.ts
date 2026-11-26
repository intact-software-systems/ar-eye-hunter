import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';

export namespace EdgeOrderSender {
    /** What the stream reads of one open send each time it stamps another. */
    export interface OpenSend {
        readonly expiresAtMs: number;
        /** False for a send nothing retries: a lost copy never comes back, so no receiver waits for it. */
        readonly retried: boolean;
        /** True once no copy of the send can still set out: it was acknowledged, refused, cancelled or failed. */
        hasEnded(): boolean;
    }
}

/**
 * The send side of one edge-ordered stream. A send takes its position in the application's own call, before
 * anything is awaited; it is stamped when its message is built, and observed once it has a lifecycle to read.
 */
export class EdgeOrderSender {
    private readonly stream: string;
    private lastPosition = 0;
    /**
     * Positions are inserted in rising order, so the first key is the lowest open position. A send is absent
     * until it is observed: it has no deadline yet, and only `endSend` closes it.
     */
    private readonly openSends = new Map<number, EdgeOrderSender.OpenSend | undefined>();

    constructor(stream: string) {
        this.stream = stream;
    }

    openSend(): number {
        this.lastPosition += 1;
        this.openSends.set(this.lastPosition, undefined);
        return this.lastPosition;
    }

    /** The stamp of an open send, from the sends still open below it at `nowMs`. */
    stampSend(position: number, nowMs: number): EdgeOrderStamp {
        this.endFinishedSends(nowMs);
        return {
            stream: this.stream,
            position,
            lowestOpenPosition: Math.min(this.openSends.keys().next().value ?? position, position),
            earlierCanArriveUntilMs: this.computeEarlierCanArriveUntil(position)
        };
    }

    observeSend(position: number, send: EdgeOrderSender.OpenSend): void {
        if (this.openSends.has(position)) {
            this.openSends.set(position, send);
        }
    }

    /** Closes a send that will never have a lifecycle to read: it threw before it was handed to a carrier. */
    endSend(position: number): void {
        this.openSends.delete(position);
    }

    private endFinishedSends(nowMs: number): void {
        for (const [position, send] of this.openSends) {
            if (send !== undefined && (send.expiresAtMs <= nowMs || send.hasEnded())) {
                this.openSends.delete(position);
            }
        }
    }

    /** A send with no deadline yet can arrive for as long as any receiver is willing to wait. */
    private computeEarlierCanArriveUntil(position: number): number | undefined {
        let latestDeadlineMs: number | undefined;
        for (const [openPosition, send] of this.openSends) {
            if (openPosition >= position) {
                break;
            }
            const deadlineMs = send === undefined ? Number.MAX_SAFE_INTEGER : send.expiresAtMs;
            if (send?.retried !== false && (latestDeadlineMs === undefined || deadlineMs > latestDeadlineMs)) {
                latestDeadlineMs = deadlineMs;
            }
        }
        return latestDeadlineMs;
    }
}
