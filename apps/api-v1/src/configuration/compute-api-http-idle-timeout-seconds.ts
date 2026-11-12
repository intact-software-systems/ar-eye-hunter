import type { ApiV1AppInboxCompletionWaitConfiguration } from './api-v1-configuration.ts';

/** `Bun.serve` rejects a larger `idleTimeout`. */
export const BUN_MAX_IDLE_TIMEOUT_SECONDS = 255;

/** Covers the request's work before its completion wait starts and the wait's final poll interval. */
const IDLE_MARGIN_SECONDS = 10;

/**
 * A mutation request writes no bytes while it awaits AppInbox completion, so the connection's idle bound must
 * outlast that wait or Bun drops the socket before the typed timeout response.
 */
export function computeApiHttpIdleTimeoutSeconds(completionWait: ApiV1AppInboxCompletionWaitConfiguration): number {
    return Math.ceil(completionWait.maxElapsedMs / 1000) + IDLE_MARGIN_SECONDS;
}
