import type { ControlRunManagerFetch } from '../../control-run-manager.ts';

export function controlFetchWithSignal(
    fetchFn: ControlRunManagerFetch | undefined,
    signal: AbortSignal | undefined,
): ControlRunManagerFetch {
    const request = fetchFn ?? fetch;
    return async (input, init) => {
        throwIfControlAborted(signal);
        const response = await request(input, {
            ...init,
            signal: signal ?? init?.signal,
        });
        throwIfControlAborted(signal);
        return response;
    };
}

export function controlFetchWithAuthorization(
    fetchFn: ControlRunManagerFetch,
    token: string | undefined,
): ControlRunManagerFetch {
    return (input, init) => {
        const headers = new Headers(
            input instanceof Request ? input.headers : undefined,
        );
        new Headers(init?.headers).forEach((value, key) => {
            headers.set(key, value);
        });
        headers.delete('Authorization');
        if (token && token.trim().length > 0) {
            headers.set('Authorization', `Bearer ${token.trim()}`);
        }
        return fetchFn(input, { ...init, headers });
    };
}

export function throwIfControlAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
}

export function isControlAbortError(error: unknown): boolean {
    return Boolean(
        error &&
            typeof error === 'object' &&
            'name' in error &&
            error.name === 'AbortError',
    );
}
