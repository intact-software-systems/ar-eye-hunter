import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALStorageEvent,
    ALStoragePersistOutcome
} from '@shared/alm/storage/al-storage-event.ts';
import type { ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';
import { toError } from '@shared/resilience/to-error.ts';

export type ALStorageAvailability =
    | Readonly<{ kind: 'available'; }>
    | Readonly<{ kind: 'unavailable'; reason: ALStorageUnavailable; }>;

export type BrowserStoragePersistRequest = (() => Promise<boolean>) | undefined;

export namespace BrowserALStorageAvailability {
    export interface Input {
        readonly initial: ALStorageAvailability;
        readonly requestPersist: BrowserStoragePersistRequest;
        readonly storage: (event: ALStorageEvent) => void;
    }
}

/**
 * Storage missing for the document holds until the next connect; any other cause is tried again by
 * the next durable admission, whose verdict re-decides it. A checkpoint store that reads `failing`,
 * for a lag beyond its bound or any other cause, skips the checkpoint lane until that store reads
 * `healthy` or `delayed` again; `delayed` alone never skips it.
 */
export class BrowserALStorageAvailability {
    readonly availability = new ObservableLatestValue<ALStorageAvailability>();
    private readonly input: BrowserALStorageAvailability.Input;
    private readonly checkpointFailures = new LatestRepository<string, ALStorageUnavailable>();
    private persistRequested = false;

    constructor(input: BrowserALStorageAvailability.Input) {
        this.input = input;
        this.availability.accept(input.initial);
    }

    getDurableLaneSkip(): ALStorageUnavailable | undefined {
        const current = this.availability.get();
        return current.kind === 'unavailable' && current.reason.cause === 'missing'
            ? current.reason
            : undefined;
    }

    getCheckpointLaneSkip(): ALStorageUnavailable | undefined {
        const [failure] = this.checkpointFailures.values();
        return this.getDurableLaneSkip() ?? failure?.peek();
    }

    /**
     * A store's health states only a change of status, so a store already failing never states a later
     * lag: every `failing` of a checkpoint store skips the lane, and `delayed` or `healthy` ends the skip.
     */
    recordCheckpointHealth(event: ALStorageEvent): void {
        if (event.kind !== 'health') {
            return;
        }
        if (event.status === 'failing') {
            this.checkpointFailures.accept(
                event.storeId,
                event.lastFailure ?? toUnstatedCheckpointFailure(event.storeId)
            );
            return;
        }
        this.checkpointFailures.delete(event.storeId);
    }

    /** Never awaited: a browser may answer `persist()` only after prompting the user. */
    requestPersistentStorage(): void {
        if (this.persistRequested) {
            return;
        }
        this.persistRequested = true;
        void readStoragePersistOutcome(this.input.requestPersist)
            .then((outcome) => this.input.storage({ kind: 'persist', outcome }))
            .catch((error) => console.error('Failed to report the storage persist outcome:', toError(error)));
    }
}

export function toInitialALStorageAvailability(indexedDbSupported: boolean): ALStorageAvailability {
    return indexedDbSupported
        ? { kind: 'available' }
        : {
            kind: 'unavailable',
            reason: { cause: 'missing', detail: 'IndexedDB is not available in this environment' }
        };
}

export function computeALStorageAvailability(
    previous: ALStorageAvailability,
    verdict: ALDeliveryAdmissionVerdict
): ALStorageAvailability {
    if (verdict.kind === 'storage-unavailable') {
        return { kind: 'unavailable', reason: { cause: verdict.cause, detail: verdict.detail } };
    }
    if (verdict.kind !== 'admitted' || !verdict.durable || previous.kind === 'available') {
        return previous;
    }
    return { kind: 'available' };
}

/** Reads an earlier grant first, so a browser that already persists this origin is not asked again. */
export function toBrowserStoragePersistRequest(
    storageManager:
        | Readonly<{ persist?: () => Promise<boolean>; persisted?: () => Promise<boolean>; }>
        | undefined
): BrowserStoragePersistRequest {
    const persist = storageManager?.persist;
    if (persist === undefined) {
        return undefined;
    }
    const persisted = storageManager?.persisted;
    return async () => (await persisted?.call(storageManager)) === true || await persist.call(storageManager);
}

/** A failing state carries its failure; an ended session's purge is the one that may state none. */
function toUnstatedCheckpointFailure(storeId: string): ALStorageUnavailable {
    return { cause: 'transaction-failed', detail: `The checkpoint store ${storeId} is failing` };
}

async function readStoragePersistOutcome(
    requestPersist: BrowserStoragePersistRequest
): Promise<ALStoragePersistOutcome> {
    if (requestPersist === undefined) {
        return 'unsupported';
    }
    return await requestPersist().then(
        (granted): ALStoragePersistOutcome => granted ? 'granted' : 'denied',
        (): ALStoragePersistOutcome => 'denied'
    );
}
