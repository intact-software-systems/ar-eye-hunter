import {
    EDGE_ORDER_MAX_STATED_HOLES,
    type EdgeOrderPositionRun,
    type EdgeOrderStamp
} from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';

export namespace EdgeOrderSender {
    /**
     * How a send stands when another is stamped. `delivered`: every recipient acknowledged it. `undelivered`: no copy
     * of it can still arrive, and none was acknowledged by all: it was refused or cancelled. `open` until then.
     */
    export type SendEnd = 'open' | 'delivered' | 'undelivered';

    /** What the stream reads of one open send each time it stamps another. */
    export interface OpenSend {
        readonly expiresAtMs: number;
        /** False for a send nothing retries: a lost copy never comes back, so no receiver waits for it. */
        readonly retried: boolean;
        getEnd(): SendEnd;
    }
}

/** `unobserved`: the send has its position and no lifecycle yet. `hole`: it ended and nothing of it can arrive. */
type EdgeOrderSendSlot = EdgeOrderSender.OpenSend | 'unobserved' | 'hole';

/**
 * The send side of one edge-ordered stream. A send takes its position in the application's own call, before
 * anything is awaited; it is stamped when its message is built, and observed once it has a lifecycle to read.
 */
export class EdgeOrderSender {
    private readonly stream: string;
    private lastPosition = 0;
    /**
     * In rising position order: every send still open, and every hole above the lowest of them. So the first key is
     * the lowest open position, and a hole leaves when the sends below it have ended.
     */
    private readonly slots = new Map<number, EdgeOrderSendSlot>();

    constructor(stream: string) {
        this.stream = stream;
    }

    openSend(): number {
        this.lastPosition += 1;
        this.slots.set(this.lastPosition, 'unobserved');
        return this.lastPosition;
    }

    /** The stamp of an open send, from the sends still open below it at `nowMs` and the holes among them. */
    stampSend(position: number, nowMs: number): EdgeOrderStamp {
        this.closeEndedSends(nowMs);
        return {
            stream: this.stream,
            position,
            lowestOpenPosition: Math.min(this.slots.keys().next().value ?? position, position),
            earlierCanArriveUntilMs: this.computeEarlierCanArriveUntil(position),
            holes: this.computeHolesBelow(position)
        };
    }

    observeSend(position: number, send: EdgeOrderSender.OpenSend): void {
        if (this.slots.get(position) === 'unobserved') {
            this.slots.set(position, send);
        }
    }

    /**
     * Closes a send of which nothing set out: it failed, or was refused, before any carrier took it. While no
     * later send has taken a position, the next send gets this one, so the stream has no hole at all.
     */
    endSend(position: number): void {
        if (this.slots.get(position) !== 'unobserved') {
            return;
        }
        if (position === this.lastPosition) {
            this.slots.delete(position);
            this.lastPosition -= 1;
            return;
        }
        this.slots.set(position, 'hole');
    }

    /** The sends still open and the holes the stream still states, as of the last time its ended sends were closed. */
    getOpenSendCount(): number {
        return this.slots.size;
    }

    /**
     * Closes every send that has ended by `nowMs`, and every hole below the lowest send still open. Each stamp does
     * this first; closing earlier changes no stamp, because a send that has ended stays ended.
     */
    closeEndedSends(nowMs: number): void {
        for (const [position, slot] of this.slots) {
            const end = typeof slot === 'string' ? 'open' : getSendEndAt(slot, nowMs);
            if (end === 'delivered') {
                this.slots.delete(position);
            }
            else if (end === 'undelivered') {
                this.slots.set(position, 'hole');
            }
        }
        for (const [position, slot] of this.slots) {
            if (slot !== 'hole') {
                return;
            }
            this.slots.delete(position);
        }
    }

    /** A send with no deadline yet can arrive for as long as any receiver is willing to wait. */
    private computeEarlierCanArriveUntil(position: number): number | undefined {
        let latestDeadlineMs: number | undefined;
        for (const [openPosition, slot] of this.slots) {
            if (openPosition >= position) {
                break;
            }
            if (slot === 'hole' || (slot !== 'unobserved' && !slot.retried)) {
                continue;
            }
            const deadlineMs = slot === 'unobserved' ? Number.MAX_SAFE_INTEGER : slot.expiresAtMs;
            if (latestDeadlineMs === undefined || deadlineMs > latestDeadlineMs) {
                latestDeadlineMs = deadlineMs;
            }
        }
        return latestDeadlineMs;
    }

    private computeHolesBelow(position: number): readonly EdgeOrderPositionRun[] {
        const holes: Array<[number, number]> = [];
        for (const [hole, slot] of this.slots) {
            if (hole >= position) {
                break;
            }
            if (slot !== 'hole') {
                continue;
            }
            const lastRun = holes.at(-1);
            if (lastRun?.[1] === hole - 1) {
                lastRun[1] = hole;
            }
            else if (holes.length === EDGE_ORDER_MAX_STATED_HOLES) {
                break;
            }
            else {
                holes.push([hole, hole]);
            }
        }
        return holes;
    }
}

/** A send past its deadline is over whatever its lifecycle says: no copy of it is handed over any more. */
function getSendEndAt(send: EdgeOrderSender.OpenSend, nowMs: number): EdgeOrderSender.SendEnd {
    const end = send.getEnd();
    return end === 'open' && send.expiresAtMs <= nowMs ? 'undelivered' : end;
}
