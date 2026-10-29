export interface AlmReloadLiveArrival {
    readonly role: string;
    readonly typeId: string;
    readonly msgId: string;
    /** Records the arrival on the recipient's page. */
    readonly record: () => void;
}

/**
 * The live arrivals a recipient page has not read yet. The reload test runs a sender segment to its end before the
 * receiver's, so the receiver page reads each paced arrival on its own timeline: a count read takes the arrivals of its
 * type in delivery order until it holds its count, and an absence read takes all of them. A `not-yet` wait between two
 * reads therefore sees only what the earlier read took, as a receiver reading live would between two opportunities.
 */
export class AlmReloadLiveArrivals {
    private readonly unread = new Map<string, AlmReloadLiveArrival[]>();
    private readonly readCounts = new Map<string, number>();

    hold(arrival: AlmReloadLiveArrival): void {
        const key = toArrivalKey(arrival.role, arrival.typeId);
        this.unread.set(key, [...this.unread.get(key) ?? [], arrival]);
    }

    /** `count` undefined reads every unread arrival of the type. */
    read(role: string, typeId: string, count: number | undefined): void {
        const key = toArrivalKey(role, typeId);
        const unread = this.unread.get(key) ?? [];
        const readCount = this.readCounts.get(key) ?? 0;
        const taken = unread.slice(0, count === undefined ? unread.length : Math.max(0, count - readCount));
        this.unread.set(key, unread.slice(taken.length));
        this.readCounts.set(key, readCount + taken.length);
        taken.forEach((arrival) => arrival.record());
    }

    isUnread(role: string, msgId: string): boolean {
        return [...this.unread.values()].some((arrivals) =>
            arrivals.some((arrival) => arrival.role === role && arrival.msgId === msgId)
        );
    }
}

function toArrivalKey(role: string, typeId: string): string {
    return JSON.stringify([role, typeId]);
}
