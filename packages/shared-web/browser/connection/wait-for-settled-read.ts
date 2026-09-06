import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';

export interface WaitForSettledReadInput<T> {
    readonly readResult: () => T;
    readonly isSettled: (result: T) => boolean;
    readonly subscribe: (listener: () => void | Promise<void>) => RallarUnsubscribe;
    readonly signal: AbortSignal | undefined;
    readonly timeoutMs: number;
    readonly toTimedOut: () => T;
    readonly toAborted: () => T;
}

/** Resolves on the first settled read, re-reading on every subscribed change. */
export async function waitForSettledRead<T>(input: WaitForSettledReadInput<T>): Promise<T> {
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
            resolve(result);
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
            input.signal?.removeEventListener('abort', onAbort);
            unsubscribe();
        };
        // A write is readable before its notification arrives, so a deadline or
        // an abort landing in that window still reports the settled read.
        const finishUnlessSettled = (fallback: () => T): void => {
            const next = input.readResult();
            finish(input.isSettled(next) ? next : fallback());
        };
        const onAbort = (): void => finishUnlessSettled(input.toAborted);
        const onChange = (): void => {
            const next = input.readResult();
            if (input.isSettled(next)) {
                finish(next);
            }
        };
        unsubscribe = input.subscribe(onChange);
        if (settled) {
            unsubscribe();
            return;
        }
        input.signal?.addEventListener('abort', onAbort, { once: true });
        // A write between the first read and the subscription raised no
        // notification this wait could see; one more read closes that gap.
        onChange();
        if (settled) {
            return;
        }
        if (input.signal?.aborted) {
            onAbort();
            return;
        }
        timeout = setTimeout(() => finishUnlessSettled(input.toTimedOut), input.timeoutMs);
    });
}
