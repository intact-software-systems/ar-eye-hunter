export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(reason?: Error): void;
}

export function createDeferred<T>(): Deferred<T> {
    let settle: Deferred<T>['resolve'] = () => {
        throw new Error('Deferred promise was not initialized.');
    };
    let fail: Deferred<T>['reject'] = () => {
        throw new Error('Deferred promise was not initialized.');
    };
    const promise = new Promise<T>((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });
    return {
        promise,
        resolve: (value) => settle(value),
        reject: (reason) => fail(reason)
    };
}
