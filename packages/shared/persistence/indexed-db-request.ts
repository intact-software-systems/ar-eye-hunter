export function readIndexedDbRequest<Result>(request: IDBRequest<Result>): Promise<Result> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

export function waitForIndexedDbTransaction(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
        transaction.oncomplete = () => resolve();
        transaction.onabort = fail;
        transaction.onerror = fail;
    });
}
