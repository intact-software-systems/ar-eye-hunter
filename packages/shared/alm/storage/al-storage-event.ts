import type { ALStorageResetEvent } from '../open-indexed-db-admission-database.ts';
import type { ALStorageUnavailable } from './al-storage-unavailable.ts';

export type ALStorageHealthStatus = 'healthy' | 'failing';

export interface ALStorageHealthState {
    readonly status: ALStorageHealthStatus;
    /** The latest failure, kept on the `healthy` that ends it; `undefined` before any failure. */
    readonly lastFailure: ALStorageUnavailable | undefined;
    /** The last durable commit of the store; `undefined` before its first one. */
    readonly lastRecoveryPointAtMs: number | undefined;
}

/** What a durable store found when its lane started: exactly one per store per connect. */
export type ALStorageRecoveryOutcome =
    | Readonly<{ kind: 'restored'; claimed: number; expired: number; }>
    | Readonly<{ kind: 'expired-at-recovery'; expired: number; }>
    | Readonly<{ kind: 'storage-created'; }>
    | Readonly<{ kind: 'storage-reset'; reason: ALStorageResetEvent['reason'] | 'other-context'; }>;

export type ALStoragePersistOutcome = 'granted' | 'denied' | 'unsupported';

/** `persist` answers the session's one persistence request, so it names no store. */
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
