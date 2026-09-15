import type {
    RallarBlackBoxTestCommandContext
} from '../rallar-black-box-test-contracts.ts';

import { CommandWithId } from './browser-command-contracts.ts';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (signal?.aborted) {
        return Promise.reject(toAbortError(signal.reason));
    }

    return new Promise((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
            cleanup();
            reject(toAbortError(signal?.reason));
        };

        timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal?.addEventListener('abort', abort, {
            once: true
        });
    });
}

export function toAbortError(reason: unknown): Error {
    if (reason instanceof Error) {
        return reason;
    }

    const message = typeof reason === 'string' && reason.length > 0
        ? reason
        : 'Rallar black-box browser adapter operation was cancelled.';
    const error = new Error(message);
    error.name = 'RALLAR_BLACK_BOX_ABORTED';
    return error;
}

export function toTimeoutError(): Error {
    const error = new Error('Rallar black-box command timeout reached.');
    error.name = 'RALLAR_BLACK_BOX_TIMEOUT';
    return error;
}
export function createBrowserCommandAbortScope(
    command: CommandWithId,
    context: RallarBlackBoxTestCommandContext,
    now: () => number
): { signal?: AbortSignal; cleanup(): void; } {
    const parentSignal = context.abortSignal?.();
    const timeoutMs = command.timeoutMs !== undefined
        ? Math.max(0, command.timeoutMs)
        : command.deadlineEpochMs !== undefined
        ? Math.max(0, command.deadlineEpochMs - now())
        : undefined;
    if (!parentSignal && timeoutMs === undefined) {
        return {
            cleanup: () => undefined
        };
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abortFromParent = () => {
        if (!controller.signal.aborted) {
            controller.abort(
                parentSignal?.reason ?? 'Rallar black-box command was cancelled.'
            );
        }
    };
    const cleanup = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
        }
        parentSignal?.removeEventListener('abort', abortFromParent);
    };

    if (parentSignal?.aborted) {
        abortFromParent();
    }
    else {
        parentSignal?.addEventListener('abort', abortFromParent, {
            once: true
        });
    }

    if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
            if (!controller.signal.aborted) {
                controller.abort(toTimeoutError());
            }
        }, timeoutMs);
    }

    return {
        signal: controller.signal,
        cleanup
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
        throw toAbortError(signal.reason);
    }

    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            signal.removeEventListener('abort', abort);
        };
        const complete = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            callback();
        };
        const abort = () => complete(() => reject(toAbortError(signal.reason)));

        signal.addEventListener('abort', abort, {
            once: true
        });
        promise.then(
            (value) => complete(() => resolve(value)),
            (error) => complete(() => reject(error))
        );
    });
}
