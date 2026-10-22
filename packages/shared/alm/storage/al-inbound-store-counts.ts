import type { ALStorageEvent } from './al-storage-event.ts';

/**
 * The ordering snapshots and the delivered markers a runtime's inbound stores hold: each store states a count after
 * the pass that bounds it, and the latest statement of each store counts. A reading is an upper bound between passes,
 * since an expiry sweep removes rows without a statement.
 */
export class ALInboundStoreCounts {
    #tracksByStoreId: Readonly<Record<string, number>> = {};
    #markersByStoreId: Readonly<Record<string, number>> = {};

    observe(event: ALStorageEvent): void {
        if (event.kind === 'ordering-tracks') {
            this.#tracksByStoreId = { ...this.#tracksByStoreId, [event.storeId]: event.tracks };
        }
        if (event.kind === 'delivered-markers') {
            this.#markersByStoreId = { ...this.#markersByStoreId, [event.storeId]: event.markers };
        }
    }

    getOrderingTracks(): number {
        return computeSum(this.#tracksByStoreId);
    }

    getDeliveredMarkers(): number {
        return computeSum(this.#markersByStoreId);
    }

    reset(): void {
        this.#tracksByStoreId = {};
        this.#markersByStoreId = {};
    }
}

function computeSum(countsByStoreId: Readonly<Record<string, number>>): number {
    return Object.values(countsByStoreId).reduce((total, count) => total + count, 0);
}
