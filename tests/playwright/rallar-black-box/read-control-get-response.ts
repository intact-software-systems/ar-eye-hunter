import type { APIResponse } from '@playwright/test';

import { toError } from '@shared/resilience/to-error.ts';
import { TryWithExhaustedError, TryWithPolicy } from '@shared/resilience/try-with-policy.ts';

/**
 * In full-scope run 45055329614 one control read failed with `read ECONNRESET`, and the same server answered the reads
 * after it; the lane already re-reads a run every 250 ms, so one more read a poll interval later costs nothing. The
 * bound keeps a dead control server failing fast and loudly, with its own transport error.
 */
const CONTROL_GET_ATTEMPTS = 3;

/** How long a control read pauses before it re-sends a request that produced no response. */
const CONTROL_GET_RETRY_PAUSE_MS = 250;

/** A control read that keeps failing in transport pauses between each of its attempts. */
export const CONTROL_GET_RETRY_BOUNDED_WAITS_MS = (CONTROL_GET_ATTEMPTS - 1) * CONTROL_GET_RETRY_PAUSE_MS;

const CONTROL_TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'ECONNREFUSED']);
const CONTROL_TRANSPORT_FAILURE_MESSAGE = /\bECONN(?:RESET|REFUSED)\b/;

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

/**
 * A connection reset or refused before any HTTP response. Playwright's request context sets the system error code the
 * server side reported on the rejected error; the message decides only for a rejection that carries no code.
 */
function isControlTransportFailure(error: Error): boolean {
    if ('code' in error && typeof error.code === 'string') {
        return CONTROL_TRANSPORT_FAILURE_CODES.has(error.code);
    }
    return CONTROL_TRANSPORT_FAILURE_MESSAGE.test(error.message);
}
