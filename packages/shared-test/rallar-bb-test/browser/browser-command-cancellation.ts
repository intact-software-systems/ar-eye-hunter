import type { RallarBlackBoxTestCommandContext } from '../rallar-black-box-test-contracts.ts';

import type { CommandWithId } from './browser-command-contracts.ts';

/** One command's cancellation: the recipe's cancel and the command's own time budget, released by `cleanup`. */
export interface BrowserCommandAbortScope {
    /** Absent when the command has neither a parent signal nor a time budget, so nothing can abort it. */
    readonly signal: AbortSignal | undefined;
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

/** A cancellation reason as the Error a cancelled command reports; a named reason keeps its message. */
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
        return { signal: undefined, cleanup: () => undefined };
    }

    const controller = new AbortController();
    const abortFromParent = () => {
        if (!controller.signal.aborted) {
            controller.abort(parentSignal?.reason ?? 'Rallar black-box command was cancelled.');
        }
    };
    if (parentSignal?.aborted) {
        abortFromParent();
    }
    else {
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
        if (!controller.signal.aborted) {
            controller.abort(createTimeoutError());
        }
    }, timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeout);
            parentSignal?.removeEventListener('abort', abortFromParent);
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

/** The command's own budget: its timeout when it names one, else what remains of its absolute deadline. */
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
