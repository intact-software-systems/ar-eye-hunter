import type { RallarBlackBoxTestCommandContext } from '../rallar-black-box-test-contracts.ts';

import type { CommandWithId } from './browser-command-contracts.ts';

export interface BrowserCommandAbortScope {
    /** Absent when the command has neither a parent signal nor a time budget, so nothing can abort it. */
    readonly signal: AbortSignal | undefined;
    readonly origin: 'timeout' | 'parent' | undefined;
    cleanup(): void;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (signal?.aborted) {
        return Promise.reject(decodeAbortReason(signal.reason));
    }

    return new Promise((resolve, reject) => {
        const listener = new AbortController();
        const timeout = setTimeout(() => {
            listener.abort();
            resolve();
        }, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(decodeAbortReason(signal.reason));
        }, { once: true, signal: listener.signal });
    });
}

export function decodeAbortReason(reason: unknown): Error {
    if (reason instanceof Error) {
        return reason;
    }
    const error = new Error(
        typeof reason === 'string' && reason.length > 0
            ? reason
            : 'Rallar black-box browser adapter operation was cancelled.'
    );
    error.name = 'RALLAR_BLACK_BOX_ABORTED';
    return error;
}

export function createBrowserCommandAbortScope(
    command: CommandWithId,
    context: RallarBlackBoxTestCommandContext,
    now: () => number
): BrowserCommandAbortScope {
    const parentSignal = context.abortSignal?.();
    const timeoutMs = resolveCommandTimeoutMs(command, now);
    if (!parentSignal && timeoutMs === undefined) {
        return { signal: undefined, origin: undefined, cleanup: () => undefined };
    }

    return new BrowserCommandCancellation(parentSignal, timeoutMs);
}

/** Owns the first abort, its provenance, and the resources forwarding it. */
class BrowserCommandCancellation implements BrowserCommandAbortScope {
    readonly #controller = new AbortController();
    readonly #parentSignal: AbortSignal | undefined;
    readonly #timeout: ReturnType<typeof setTimeout> | undefined;
    #origin: BrowserCommandAbortScope['origin'];

    constructor(parentSignal: AbortSignal | undefined, timeoutMs: number | undefined) {
        this.#parentSignal = parentSignal;
        if (parentSignal?.aborted) {
            this.#abortFromParent();
        }
        else {
            parentSignal?.addEventListener('abort', this.#abortFromParent, { once: true });
        }
        this.#timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
            if (!this.signal.aborted) {
                this.#origin = 'timeout';
                this.#controller.abort(createTimeoutError());
            }
        }, timeoutMs);
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    get origin(): BrowserCommandAbortScope['origin'] {
        return this.#origin;
    }

    cleanup(): void {
        clearTimeout(this.#timeout);
        this.#parentSignal?.removeEventListener('abort', this.#abortFromParent);
    }

    #abortFromParent = (): void => {
        if (!this.signal.aborted) {
            this.#origin = 'parent';
            this.#controller.abort(this.#parentSignal?.reason ?? 'Rallar black-box command was cancelled.');
        }
    };
}

export async function withBrowserCommandAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined
): Promise<T> {
    if (!signal) {
        return await promise;
    }
    if (signal.aborted) {
        // The operation is already running; handle its rejection without delaying cancellation.
        void promise.catch(() => undefined);
        throw decodeAbortReason(signal.reason);
    }

    const listener = new AbortController();
    try {
        return await new Promise<T>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(decodeAbortReason(signal.reason)), {
                once: true,
                signal: listener.signal
            });
            promise.then(resolve, reject);
        });
    }
    finally {
        listener.abort();
    }
}

function resolveCommandTimeoutMs(command: CommandWithId, now: () => number): number | undefined {
    if (command.timeoutMs !== undefined) {
        return Math.max(0, command.timeoutMs);
    }
    return command.deadlineEpochMs === undefined ? undefined : Math.max(0, command.deadlineEpochMs - now());
}

function createTimeoutError(): Error {
    const error = new Error('Rallar black-box command timeout reached.');
    error.name = 'RALLAR_BLACK_BOX_TIMEOUT';
    return error;
}
