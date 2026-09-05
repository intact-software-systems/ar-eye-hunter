import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';

export interface WaitForRoomChangeInput<T> {
    readonly readResult: () => T;
    readonly isSettled: (result: T) => boolean;
    readonly subscribe: (listener: () => void | Promise<void>) => RallarUnsubscribe;
    readonly signal: AbortSignal | undefined;
    readonly timeoutMs: number;
    readonly toTimedOut: () => T;
    readonly toAborted: () => T;
}

/** Resolves on the first settled read, re-reading on every subscribed change. */
export async function waitForRoomChange<T>(input: WaitForRoomChangeInput<T>): Promise<T> {
    const current = input.readResult();
    if (input.isSettled(current)) {
        return current;
    }
    if (input.signal?.aborted) {
        return input.toAborted();
    }
    if (input.timeoutMs <= 0) {
        return input.toTimedOut();
    }
    return await new Promise<T>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: RallarUnsubscribe = () => {};
        const finish = (result: T): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
            input.signal?.removeEventListener('abort', onAbort);
            unsubscribe();
            resolve(result);
        };
        const onAbort = (): void => finish(input.toAborted());
        unsubscribe = input.subscribe(() => {
            const next = input.readResult();
            if (input.isSettled(next)) {
                finish(next);
            }
        });
        input.signal?.addEventListener('abort', onAbort, { once: true });
        const next = input.readResult();
        if (input.isSettled(next)) {
            finish(next);
            return;
        }
        if (input.signal?.aborted) {
            onAbort();
            return;
        }
        timeout = setTimeout(() => finish(input.toTimedOut()), input.timeoutMs);
    });
}
