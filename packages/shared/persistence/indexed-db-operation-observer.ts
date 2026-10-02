export type IndexedDbOperationOwner = 'al-admission' | 'al-work';

export const INDEXED_DB_OPERATION_OWNERS: readonly IndexedDbOperationOwner[] = ['al-admission', 'al-work'];

/**
 * `work-page` and `work-probe` are an owner's inspections: a readiness read, and a reservation read that
 * computed no write. `work-reserve` is a reservation that computed a write, even one that then conflicted.
 */
export type IndexedDbOperationKind =
    | 'read'
    | 'list'
    | 'write'
    | 'work-read'
    | 'work-write'
    | 'work-page'
    | 'work-reserve'
    | 'work-release'
    | 'work-probe'
    | 'work-cleanup';

export const INDEXED_DB_OPERATION_KINDS: readonly IndexedDbOperationKind[] = [
    'read',
    'list',
    'write',
    'work-read',
    'work-write',
    'work-page',
    'work-reserve',
    'work-release',
    'work-probe',
    'work-cleanup'
];

export interface IndexedDbOperation {
    readonly owner: IndexedDbOperationOwner;
    readonly kind: IndexedDbOperationKind;
}

/**
 * Told of every operation an IndexedDB owner starts, before its transaction opens or before a write it
 * computed from a finished read. A returned promise holds the operation until it settles and fails it
 * with its rejection; returning nothing lets it run at once, so a pass-through observer adds no microtask.
 */
export interface IndexedDbOperationObserver {
    observe(operation: IndexedDbOperation): Promise<void> | void;
}

export interface IndexedDbOperationCounts {
    readonly total: number;
    readonly byOwner: Readonly<Record<IndexedDbOperationOwner, number>>;
    readonly byKind: Readonly<Partial<Record<IndexedDbOperationKind, number>>>;
}

export interface CountingIndexedDbOperationObserver extends IndexedDbOperationObserver {
    getCounts(): IndexedDbOperationCounts;
    reset(): void;
}

export function createPassThroughIndexedDbOperationObserver(): IndexedDbOperationObserver {
    return { observe: () => {} };
}

export function createCountingIndexedDbOperationObserver(): CountingIndexedDbOperationObserver {
    let total = 0;
    let byOwner: Record<IndexedDbOperationOwner, number> = { 'al-admission': 0, 'al-work': 0 };
    let byKind: Partial<Record<IndexedDbOperationKind, number>> = {};
    return {
        observe(operation) {
            total += 1;
            byOwner = { ...byOwner, [operation.owner]: byOwner[operation.owner] + 1 };
            byKind = { ...byKind, [operation.kind]: (byKind[operation.kind] ?? 0) + 1 };
        },
        getCounts() {
            return { total, byOwner: { ...byOwner }, byKind: { ...byKind } };
        },
        reset() {
            total = 0;
            byOwner = { 'al-admission': 0, 'al-work': 0 };
            byKind = {};
        }
    };
}
