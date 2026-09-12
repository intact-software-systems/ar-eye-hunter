import { vi } from 'vitest';

export interface RecordedIndexedDbTransactions {
    /** Every transaction the run opened, in order, so a pin can separate the read chain from the write. */
    modes(): readonly IDBTransactionMode[];
    /** How many earlier transactions still held their store locks as each one was created. */
    liveWhenOpened(): readonly number[];
    /** How many transactions still hold their store locks now. */
    liveCount(): number;
}

/**
 * Patches `IDBDatabase.prototype.transaction` and `IDBTransaction.prototype.abort` for the rest of
 * the test: the caller owns the teardown, and every suite using this needs `vi.restoreAllMocks()` in
 * an `afterEach`.
 */
export function recordIndexedDbTransactions(): RecordedIndexedDbTransactions {
    const modes: IDBTransactionMode[] = [];
    const liveWhenOpened: number[] = [];
    const live = new Set<IDBTransaction>();
    const openTransaction = IDBDatabase.prototype.transaction;
    const abortTransaction = IDBTransaction.prototype.abort;
    // abort() finishes the transaction there and then; its event arrives a task later, which is
    // already too late to say whether the write that followed queued behind it.
    vi.spyOn(IDBTransaction.prototype, 'abort').mockImplementation(function (this: IDBTransaction) {
        live.delete(this);
        abortTransaction.call(this);
    });
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        modes.push(mode ?? 'readonly');
        liveWhenOpened.push(live.size);
        const transaction = openTransaction.call(this, storeNames, mode, options);
        live.add(transaction);
        for (const ended of ['complete', 'abort', 'error']) {
            transaction.addEventListener(ended, () => live.delete(transaction));
        }
        return transaction;
    });
    return {
        modes: () => modes,
        liveWhenOpened: () => liveWhenOpened,
        liveCount: () => live.size
    };
}
