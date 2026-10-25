/** A marker the index knows: its track and the expiry the store last wrote for it. */
export interface ALInboundIndexedMarker {
    readonly trackKey: string;
    readonly expireAtTimestamp: number;
}

/**
 * The delivered markers one capped inbound store holds, in the order their expiry last moved forward, so the least
 * recently admitted track's marker is the head: found, moved and forgotten in O(1).
 *
 * The order is not strictly the expiry order: a marker's expiry also covers its buffered releases, which may outlive
 * the track TTL. An expired marker behind a live head therefore stays counted until it reaches the head, so `count` is
 * an upper bound, and a pass that meets such a marker counts its removal against the excess it inflated.
 *
 * The index learns a marker from the store's own commits. `load` adds the rows the store held before the index
 * existed, earliest expiry first, ahead of every marker a commit already named.
 */
export class ALInboundDeliveredMarkerIndex {
    #loaded = false;
    #markers = new Map<string, number>();

    get loaded(): boolean {
        return this.#loaded;
    }

    /** Called once, before the first eviction. */
    load(held: readonly ALInboundIndexedMarker[]): void {
        const unnamed = held
            .filter((marker) => !this.#markers.has(marker.trackKey))
            .sort((left, right) => left.expireAtTimestamp - right.expireAtTimestamp);
        this.#markers = new Map([
            ...unnamed.map((marker): [string, number] => [marker.trackKey, marker.expireAtTimestamp]),
            ...this.#markers
        ]);
        this.#loaded = true;
    }

    /** A committed marker write; a later expiry moves the marker behind every other marker. */
    record(marker: ALInboundIndexedMarker): void {
        const known = this.#markers.get(marker.trackKey);
        if (known !== undefined && known >= marker.expireAtTimestamp) {
            return;
        }
        this.#markers.delete(marker.trackKey);
        this.#markers.set(marker.trackKey, marker.expireAtTimestamp);
    }

    forget(trackKey: string): void {
        this.#markers.delete(trackKey);
    }

    /**
     * The markers from the least recently admitted, read lazily from the live map after the expired heads are dropped:
     * a marker the caller forgets is not read again, and one it records again is read once more after the others.
     */
    *getOldest(nowMs: number): Generator<ALInboundIndexedMarker> {
        this.#dropExpiredHeads(nowMs);
        for (const [trackKey, expireAtTimestamp] of this.#markers) {
            yield { trackKey, expireAtTimestamp };
        }
    }

    /** The markers the index holds once the expired heads are dropped, so a departed sender's markers leave it. */
    count(nowMs: number): number {
        this.#dropExpiredHeads(nowMs);
        return this.#markers.size;
    }

    #dropExpiredHeads(nowMs: number): void {
        for (const [trackKey, expireAtTimestamp] of this.#markers) {
            if (expireAtTimestamp > nowMs) {
                return;
            }
            this.#markers.delete(trackKey);
        }
    }
}
