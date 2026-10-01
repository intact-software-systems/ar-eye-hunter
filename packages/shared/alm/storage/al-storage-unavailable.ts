// packages/shared/alm/storage/al-storage-unavailable.ts
/**
 * Why a browser ALM store cannot persist: IndexedDB is absent (`missing`), its open request failed
 * (`open-failed`), a reset's delete stayed blocked (`reset-blocked`), a write hit the quota (`quota`),
 * a `versionchange` closed the connection (`closed`), the database vanished under the document
 * (`evicted`), or a transaction failed for another reason (`transaction-failed`).
 */
export type ALStorageUnavailableCause =
    | 'missing'
    | 'open-failed'
    | 'reset-blocked'
    | 'quota'
    | 'closed'
    | 'evicted'
    | 'transaction-failed';

export interface ALStorageUnavailable {
    readonly cause: ALStorageUnavailableCause;
    readonly detail: string;
}

/** Raised where only the raising code knows the cause: IndexedDB absent, an open that failed, a database that vanished. */
export class ALStorageUnavailableError extends Error {
    readonly unavailable: ALStorageUnavailable;

    constructor(unavailable: ALStorageUnavailable, options?: ErrorOptions) {
        super(unavailable.detail, options);
        this.name = 'ALStorageUnavailableError';
        this.unavailable = unavailable;
    }
}

const AL_STORAGE_UNAVAILABLE_CAUSES_BY_DOM_EXCEPTION_NAME: ReadonlyMap<string, ALStorageUnavailableCause> = new Map([
    ['QuotaExceededError', 'quota'],
    ['InvalidStateError', 'closed'],
    ['UnknownError', 'transaction-failed'],
    ['AbortError', 'transaction-failed'],
    ['TransactionInactiveError', 'transaction-failed']
]);

/**
 * The storage failure an error is, or `undefined` for every other error: a write deadline, a corrupt
 * row, a conflict and a code defect keep their own meanings. The PostgreSQL backend raises none of these.
 */
export function toALStorageUnavailable(error: Error): ALStorageUnavailable | undefined {
    if (error instanceof ALStorageUnavailableError) {
        return error.unavailable;
    }
    const cause = isDOMException(error)
        ? AL_STORAGE_UNAVAILABLE_CAUSES_BY_DOM_EXCEPTION_NAME.get(error.name)
        : undefined;
    return cause === undefined ? undefined : { cause, detail: `${error.name}: ${error.message}` };
}

function isDOMException(error: Error): error is DOMException {
    return typeof DOMException !== 'undefined' && error instanceof DOMException;
}
