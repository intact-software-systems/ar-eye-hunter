/** A marker the index knows: its track and the expiry the store last wrote for it. */
export interface ALInboundIndexedMarker {
    readonly trackKey: string;
    readonly expireAtTimestamp: number;
}

/**
 * The delivered markers one inbound store holds, kept per sender in the order their expiry last moved forward, so the
 * marker that expires first is the head of its sender's map: found, moved and forgotten in O(1).
 *
 * The index learns a marker from the store's own commits, which name the sender. Rows the store held before the index
 * existed carry no readable sender (a track key joins an ordering key and a sender id that may both hold colons), so
 * `load` keeps them apart, earliest expiry first; they count toward the total and leave by expiry, or move under their
 * sender when a commit writes them again.
 */
export class ALInboundDeliveredMarkerIndex {
    #loaded = false;
    readonly #bySender = new Map<string, Map<string, number>>();
    readonly #senderByTrack = new Map<string, string>();
    readonly #unattributed = new Map<string, number>();

    get loaded(): boolean {
        return this.#loaded;
    }

    /** Adds the rows the store held that no commit has named yet; called once, before the first eviction. */
    load(held: readonly ALInboundIndexedMarker[]): void {
        const unnamed = held.filter((marker) => !this.#senderByTrack.has(marker.trackKey));
        for (const marker of [...unnamed].sort((left, right) => left.expireAtTimestamp - right.expireAtTimestamp)) {
            this.#unattributed.set(marker.trackKey, marker.expireAtTimestamp);
        }
        this.#loaded = true;
    }

    /** A committed marker write; a later expiry moves the marker behind every other marker of its sender. */
    record(senderId: string, marker: ALInboundIndexedMarker): void {
        this.#unattributed.delete(marker.trackKey);
        const markers = this.#bySender.get(senderId) ?? new Map<string, number>();
        const known = markers.get(marker.trackKey);
        if (known !== undefined && known >= marker.expireAtTimestamp) {
            return;
        }
        markers.delete(marker.trackKey);
        markers.set(marker.trackKey, marker.expireAtTimestamp);
        this.#bySender.set(senderId, markers);
        this.#senderByTrack.set(marker.trackKey, senderId);
    }

    forget(senderId: string, trackKey: string): void {
        const markers = this.#bySender.get(senderId);
        markers?.delete(trackKey);
        if (markers?.size === 0) {
            this.#bySender.delete(senderId);
        }
        this.#senderByTrack.delete(trackKey);
    }

    /**
     * The sender's markers from the first to expire, read lazily from the live map: a marker the caller forgets is not
     * read again, and one it records again is read once more after the others.
     */
    *readOldest(senderId: string, nowMs: number): Generator<ALInboundIndexedMarker> {
        this.#dropExpiredHeads(senderId, nowMs);
        for (const [trackKey, expireAtTimestamp] of this.#bySender.get(senderId) ?? []) {
            yield { trackKey, expireAtTimestamp };
        }
    }

    countSender(senderId: string, nowMs: number): number {
        this.#dropExpiredHeads(senderId, nowMs);
        return this.#bySender.get(senderId)?.size ?? 0;
    }

    /** Every marker the index holds; an expired one past its sender's head counts until its sender's next pass. */
    count(nowMs: number): number {
        dropExpiredHeads(this.#unattributed, nowMs);
        let total = this.#unattributed.size;
        for (const markers of this.#bySender.values()) {
            total += markers.size;
        }
        return total;
    }

    #dropExpiredHeads(senderId: string, nowMs: number): void {
        const markers = this.#bySender.get(senderId);
        for (const trackKey of markers === undefined ? [] : dropExpiredHeads(markers, nowMs)) {
            this.#senderByTrack.delete(trackKey);
        }
    }
}

/** Drops the head entries whose expiry has passed and answers their keys. */
function dropExpiredHeads(markers: Map<string, number>, nowMs: number): readonly string[] {
    const dropped: string[] = [];
    for (const [trackKey, expireAtTimestamp] of markers) {
        if (expireAtTimestamp > nowMs) {
            break;
        }
        markers.delete(trackKey);
        dropped.push(trackKey);
    }
    return dropped;
}
