export type BrowserStorageDeletionStatus = 'cleared' | 'failed' | 'unavailable';

export interface BrowserStorageDeletion {
    readonly localStorage: BrowserStorageDeletionStatus;
    readonly sessionStorage: BrowserStorageDeletionStatus;
}

/** A remote reset starts the agent page from empty browser storage; a storage that throws reports failed. */
export function deleteBrowserStorageEntries(): BrowserStorageDeletion {
    return {
        localStorage: deleteStorageEntries('localStorage'),
        sessionStorage: deleteStorageEntries('sessionStorage')
    };
}

/** Reading the storage property itself can throw in a sandboxed page, so the read stays inside the guard. */
function deleteStorageEntries(storageName: 'localStorage' | 'sessionStorage'): BrowserStorageDeletionStatus {
    try {
        const storage: Storage | undefined = globalThis[storageName];
        if (!storage) {
            return 'unavailable';
        }
        storage.clear();
        return 'cleared';
    }
    catch {
        return 'failed';
    }
}
