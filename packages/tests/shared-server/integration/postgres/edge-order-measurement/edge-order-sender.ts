/**
 * What a message of an edge-ordered stream carries, so that a receiver can put the stream back in its sender's order
 * and knows how long a missing message can still arrive. The measurement's own stamp, not the product's.
 */
export interface EdgeOrderStamp {
    /** The stream: minted in memory once per sender page and channel. */
    readonly s: string;
    /** The send's position, from 1, taken when the application calls send. */
    readonly n: number;
    /** The latest deadline among earlier sends the sender has not seen end, in epoch ms; 0 when none can still arrive. */
    readonly w: number;
}

/** The stamp a payload carried, or undefined when the payload is not one. */
export function decodeEdgeOrderStamp(value: unknown): EdgeOrderStamp | undefined {
    if (typeof value !== 'object' || value === null || !('s' in value) || !('n' in value) || !('w' in value)) {
        return undefined;
    }
    const { s, n, w } = value;
    return typeof s === 'string' && typeof n === 'number' && typeof w === 'number' ? { s, n, w } : undefined;
}

/** The send side of one stream: it numbers each send and says how long earlier ones can still arrive. */
export class EdgeOrderSender {
    readonly stream: string;
    private position = 0;
    private readonly openDeadlines = new Map<number, number>();

    constructor(stream: string) {
        this.stream = stream;
    }

    /** Takes the next position. The send stays open, and so can still arrive, until `end` is told otherwise. */
    stamp(expiresAtMs: number): EdgeOrderStamp {
        this.position += 1;
        const w = Math.max(0, ...this.openDeadlines.values());
        this.openDeadlines.set(this.position, expiresAtMs);
        return { s: this.stream, n: this.position, w };
    }

    /** The send at `position` reached a terminal state: no copy of it can arrive from now on. */
    end(position: number): void {
        this.openDeadlines.delete(position);
    }
}
