import type { ALStorageResetEvent } from '../open-indexed-db-admission-database.ts';
import type { ALStorageUnavailable } from './al-storage-unavailable.ts';

/** `delayed` only on a checkpoint store: its oldest unsaved change outlived the interval, within the lag bound. */
export type ALStorageHealthStatus = 'healthy' | 'delayed' | 'failing';

export interface ALStorageHealthState {
    readonly status: ALStorageHealthStatus;
    /**
     * The latest failure, kept on the `healthy` that ends it. `undefined` only in the state before any
     * failure, which no event carries, and on an ended session's purge that failed for no storage cause.
     */
    readonly lastFailure: ALStorageUnavailable | undefined;
    /** The store's last recovery point; `undefined` before its first one. */
    readonly lastRecoveryPointAtMs: number | undefined;
    /** How old a checkpoint store's oldest unsaved change was when it went `delayed` or `failing`; else `undefined`. */
    readonly oldestUnsavedAgeMs: number | undefined;
}

/** What a durable store found when its lane started: exactly one per store, or per lane of a shared store, per connect. */
export type ALStorageRecoveryOutcome =
    | Readonly<{ kind: 'restored'; claimed: number; expired: number; }>
    | Readonly<{ kind: 'expired-at-recovery'; expired: number; }>
    | Readonly<{ kind: 'storage-created'; }>
    | Readonly<{ kind: 'storage-reset'; reason: ALStorageResetEvent['reason'] | 'other-context'; }>;

export type ALStoragePersistOutcome = 'granted' | 'denied' | 'unsupported';

/**
 * `persist` answers the session's one persistence request, so it names no store. A reset the cleanup
 * caused names the database it reset, not a store. A recovery of a store two lanes share names the lane
 * after the store id, as `<store id>/<lane>`.
 */
export type ALStorageEvent =
    | Readonly<{ kind: 'reset'; storeId: string; event: ALStorageResetEvent; }>
    | Readonly<{ kind: 'recovery'; storeId: string; outcome: ALStorageRecoveryOutcome; }>
    | (Readonly<{ kind: 'health'; storeId: string; }> & ALStorageHealthState)
    | Readonly<{ kind: 'persist'; outcome: ALStoragePersistOutcome; }>;

export type ALStorageEventSink = (event: ALStorageEvent) => void;

export function createPassThroughALStorageEventSink(): ALStorageEventSink {
    return () => {};
}

export function toALStorageResetSink(
    storage: ALStorageEventSink,
    storeId: string
): (event: ALStorageResetEvent) => void {
    return (event) => storage({ kind: 'reset', storeId, event });
}
