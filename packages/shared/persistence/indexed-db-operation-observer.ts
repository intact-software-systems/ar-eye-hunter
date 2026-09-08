export type IndexedDbOperationOwner = 'al-admission' | 'al-work';

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

export interface IndexedDbOperation {
    readonly owner: IndexedDbOperationOwner;
    readonly kind: IndexedDbOperationKind;
}

export interface IndexedDbOperationObserver {
    observe(operation: IndexedDbOperation): void;
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
