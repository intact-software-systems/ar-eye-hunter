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

/**
 * How long a send that every recipient acknowledged stays open: the entry window's figure. A recipient acknowledges
 * when it admits a message, which is before its own sorter has it, so a stamp made in this time still says the send
 * can arrive.
 */
export const EDGE_ORDER_ACKNOWLEDGED_SETTLE_MS = 500;

/** An acknowledged send in its settle time, counted from the stamp that first read the acknowledgement. */
interface EdgeOrderSettlingSend {
    readonly openUntilMs: number;
}

/** `unobserved`: the send has its position and no lifecycle yet. `hole`: it ended and nothing of it can arrive. */
type EdgeOrderSendSlot = EdgeOrderSender.OpenSend | EdgeOrderSettlingSend | 'unobserved' | 'hole';

/**
 * The send side of one edge-ordered stream. A send takes its position in the application's own call, before
 * anything is awaited; it is stamped when its message is built, and observed once it has a lifecycle to read.
 */
export class EdgeOrderSender {
    private readonly stream: string;
    private readonly acknowledgedSettleMs: number;
    private lastPosition = 0;
    /**
     * In rising position order: every send still open, an acknowledged one in its settle time among them, and every
     * hole above the lowest of them. So the first key is the lowest open position, and a hole leaves when the sends
     * below it have ended.
     */
    private readonly slots = new Map<number, EdgeOrderSendSlot>();

    constructor(stream: string, acknowledgedSettleMs: number) {
        this.stream = stream;
        this.acknowledgedSettleMs = acknowledgedSettleMs;
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
            const slotNow = toSendSlotAt(slot, nowMs, this.acknowledgedSettleMs);
            if (slotNow === undefined) {
                this.slots.delete(position);
            }
            else if (slotNow !== slot) {
                this.slots.set(position, slotNow);
            }
        }
        for (const [position, slot] of this.slots) {
            if (slot !== 'hole') {
                return;
            }
            this.slots.delete(position);
        }
    }

    /**
     * The latest time a send still open below `position` can arrive: its deadline, the end of its settle time once
     * it is acknowledged, or as long as any receiver is willing to wait while it has no deadline yet.
     */
    private computeEarlierCanArriveUntil(position: number): number | undefined {
        let latestMs: number | undefined;
        for (const [openPosition, slot] of this.slots) {
            if (openPosition >= position) {
                break;
            }
            const canArriveUntilMs = toCanArriveUntil(slot);
            if (canArriveUntilMs !== undefined && (latestMs === undefined || canArriveUntilMs > latestMs)) {
                latestMs = canArriveUntilMs;
            }
        }
        return latestMs;
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

/**
 * The slot as it stands at `nowMs`; absent once nothing of the send is left to state. A send past its deadline is over
 * whatever its lifecycle says, since no copy of it is handed over any more, and an acknowledged send is open for its
 * settle time and never past its deadline.
 */
function toSendSlotAt(
    slot: EdgeOrderSendSlot,
    nowMs: number,
    acknowledgedSettleMs: number
): EdgeOrderSendSlot | undefined {
    if (typeof slot === 'string') {
        return slot;
    }
    if ('openUntilMs' in slot) {
        return slot.openUntilMs > nowMs ? slot : undefined;
    }
    const end = slot.getEnd();
    if (end === 'delivered') {
        const openUntilMs = Math.min(nowMs + acknowledgedSettleMs, slot.expiresAtMs);
        return openUntilMs > nowMs ? { openUntilMs } : undefined;
    }
    return end === 'undelivered' || slot.expiresAtMs <= nowMs ? 'hole' : slot;
}

/** Absent for a hole, and for a send nothing retries: no receiver waits for either. */
function toCanArriveUntil(slot: EdgeOrderSendSlot): number | undefined {
    if (slot === 'hole') {
        return undefined;
    }
    if (slot === 'unobserved') {
        return Number.MAX_SAFE_INTEGER;
    }
    if ('openUntilMs' in slot) {
        return slot.openUntilMs;
    }
    return slot.retried ? slot.expiresAtMs : undefined;
}
