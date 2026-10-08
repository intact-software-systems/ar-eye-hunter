import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';

/**
 * The ordering snapshots the page's inbound stores hold (D191): each store states its count after the eviction pass a
 * new track runs, and the page holds the latest statement of each. One reading spans one connection: the runtime's
 * `close` resets it, so a reconnect reads 0 until a store opens a track.
 */
export interface BlackBoxRallarOrderingTracks {
    observe(event: ALStorageEvent): void;
    /** The latest count of every store that stated one, summed. */
    getOrderingTracks(): number;
    reset(): void;
}

export function createBlackBoxRallarOrderingTracks(): BlackBoxRallarOrderingTracks {
    let tracksByStoreId: Readonly<Record<string, number>> = {};
    return {
        observe(event) {
            if (event.kind === 'ordering-tracks') {
                tracksByStoreId = { ...tracksByStoreId, [event.storeId]: event.tracks };
            }
        },
        getOrderingTracks: () => Object.values(tracksByStoreId).reduce((total, tracks) => total + tracks, 0),
        reset() {
            tracksByStoreId = {};
        }
    };
}
