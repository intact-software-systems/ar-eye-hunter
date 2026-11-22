import type { APIResponse } from '@playwright/test';

import { toError } from '@shared/resilience/to-error.ts';
import { TryWithExhaustedError, TryWithPolicy } from '@shared/resilience/try-with-policy.ts';

/**
 * Across six full-scope ALM runs one control read failed with `read ECONNRESET`, and the same server answered the reads
 * after it; the lane already re-reads a run every 250 ms, so one more read a poll interval later costs nothing. The
 * bound keeps a dead control server failing fast and loudly, with its own transport error.
 */
const CONTROL_GET_ATTEMPTS = 3;
const CONTROL_GET_RETRY_PAUSE_MS = 250;
const CONTROL_TRANSPORT_FAILURE = /\bECONN(?:RESET|REFUSED)\b/;

/**
 * Sends an idempotent control GET, re-sending it when the request produced no HTTP response. A response of any status
 * is the server's answer and returns as it is.
 */
export async function readControlGetResponse(get: () => Promise<APIResponse>): Promise<APIResponse> {
    try {
        return await TryWithPolicy.defaults().label('control GET')
            .maxAttempts(CONTROL_GET_ATTEMPTS)
            .retryIntervalMsecs(CONTROL_GET_RETRY_PAUSE_MS)
            .maxRetryIntervalMsecs(CONTROL_GET_RETRY_PAUSE_MS)
            .backoffFactor(1)
            .jitterRatio(0)
            .retryIf((error) => isControlTransportFailure(toError(error)))
            .run(get);
    }
    catch (error) {
        throw error instanceof TryWithExhaustedError ? error.cause : error;
    }
}

/** A connection reset or refused before any HTTP response, as Playwright's request context reports it. */
export function isControlTransportFailure(error: Error): boolean {
    return CONTROL_TRANSPORT_FAILURE.test(error.message);
}
