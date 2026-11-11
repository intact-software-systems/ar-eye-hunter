import { DeadlineAbortScope } from '@shared/resilience/timing/deadline-abort-scope.ts';
import { sleepWithAbortReason } from '@shared/resilience/timing/sleep-with-abort-reason.ts';

import type { RallarBlackBoxTestCommandContext } from '../rallar-black-box-test-contracts.ts';

import type { CommandWithId } from './browser-command-contracts.ts';

export interface BrowserCommandAbortScope {
    /** Absent when the command has neither a parent signal nor a time budget, so nothing can abort it. */
    readonly signal: AbortSignal | undefined;
    readonly origin: 'timeout' | 'parent' | undefined;
    cleanup(): void;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleepWithAbortReason(ms, signal, (aborted) => decodeAbortReason(aborted.reason));
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

    const scope = new DeadlineAbortScope({
        parentSignal,
        timeoutMs,
        toParentReason: (parent) => parent.reason ?? 'Rallar black-box command was cancelled.',
        toTimeoutReason: createTimeoutError
    });
    return {
        signal: scope.signal,
        get origin() {
            const origin = scope.origin();
            return origin === 'caller' ? undefined : origin;
        },
        cleanup: () => scope.cleanup()
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
