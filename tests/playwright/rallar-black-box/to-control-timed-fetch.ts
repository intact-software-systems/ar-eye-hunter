import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';

/**
 * A `fetch` that sends every request to the control server under the control request timeout, as a harness injects
 * it into an operator that takes its `fetch` as a dependency; a signal of the caller's own still ends the request.
 */
export function toControlTimedFetch(send: typeof fetch): typeof fetch {
    return async (url, init) => {
        const timeout = AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS);
        const signal = init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
        return await send(url, { ...init, signal });
    };
}
